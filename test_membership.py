import base64
import html
import io
import re
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import Mock, patch

from PIL import Image

from github_annotations import API, ISSUES, GitHubPublisher
from membership import create_app, digest
from topic_attachments import TOPIC_FILE_LIMIT


class GitHubPublisherTests(unittest.TestCase):
    @patch("github_annotations.requests.get")
    def test_find_checks_authenticated_app_when_issue_only_has_bot_author(self, get):
        marker = "<!-- intersophia-publication:test-marker -->"
        publisher = GitHubPublisher("123", "456", "unused.pem")
        publisher.headers = Mock(return_value={"Authorization": "installation"})
        publisher.app_headers = Mock(return_value={"Authorization": "app"})
        bot = {"type": "Bot", "login": "intersophia-dev-annotations[bot]"}

        def issue(number, **fields):
            return {"number": number, "body": marker, "user": bot} | fields

        page = Mock(links={})
        page.json.return_value = [
            issue(1, user={"type": "User", "login": bot["login"]}),
            issue(2, user={"type": "Bot", "login": "other[bot]"}),
            issue(3, performed_via_github_app={"id": 789}),
            issue(4, body=f"Copied marker: {marker}"),
            issue(5, pull_request={}),
            issue(6, body=f"Synthetic description\n\n{marker}"),
        ]
        app = Mock()
        app.json.return_value = {"id": 123, "slug": "intersophia-dev-annotations"}
        get.side_effect = [page, app]

        self.assertEqual(publisher.find(marker, 1_700_000_000), 6)
        self.assertEqual([call.args[0] for call in get.call_args_list], [ISSUES, f"{API}/app"])
        self.assertEqual(get.call_args.kwargs["headers"], {"Authorization": "app"})

    @patch("github_annotations.requests.get")
    def test_find_accepts_explicit_matching_app_without_bot_lookup(self, get):
        marker = "<!-- intersophia-publication:test-marker -->"
        publisher = GitHubPublisher("123", "456", "unused.pem")
        publisher.headers = Mock(return_value={})
        publisher.app_headers = Mock()
        get.return_value.json.return_value = [
            {"number": 7, "body": marker, "performed_via_github_app": {"id": 123}},
        ]

        self.assertEqual(publisher.find(marker, 1_700_000_000), 7)
        publisher.app_headers.assert_not_called()


class MembershipTests(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.path = str(Path(scratch.name) / "test.sqlite")
        self.app = create_app({
            "TESTING": True, "SECRET_KEY": "test-only-not-a-secret-" * 2, "DATABASE": self.path,
            "GOOGLE_CLIENT_ID": "test-client", "GOOGLE_CLIENT_SECRET": "test-secret",
        })
        result = self.app.test_cli_runner().invoke(args=["init-db"])
        self.assertEqual(result.exit_code, 0, result.output)
        self.client = self.app.test_client()
        self.base = "https://dev.intersophia.pl"
        self.google = self.app.extensions["authlib.integrations.flask_client"].google
        self.claims = {"sub": "one", "email": "tester@gmail.com", "email_verified": True, "name": "Ania Nowak"}

    def invite(self, address="tester@gmail.com"):
        result = self.app.test_cli_runner().invoke(args=["invite", address])
        self.assertEqual(result.exit_code, 0, result.output)
        url = result.output.strip()
        return url.removeprefix(self.base)

    def response(self, path, **kw):
        return self.client.get(path, base_url=self.base, **kw)

    def csrf(self, path):
        data = self.response(path).get_data(as_text=True)
        return html.unescape(re.search(r'name="csrf" value="([^"]+)"', data)[1])

    def callback(self, **changes):
        with patch.object(self.google, "authorize_access_token",
                          return_value={"userinfo": self.claims | changes}):
            return self.response("/auth/google/callback")

    def test_invite_welcome_and_member_panel_persist_on_return(self):
        link = self.invite()
        self.assertEqual(self.response(link).location, "/logowanie")
        csrf = self.csrf("/logowanie")
        with patch.object(self.google, "authorize_redirect", return_value=("OAuth", 200)) as auth:
            self.client.post("/auth/google", data={"csrf": csrf}, base_url=self.base)
        auth.assert_called_once_with(self.base + "/auth/google/callback",
                                     prompt="select_account", login_hint="tester@gmail.com")
        self.assertEqual(self.callback().location, "/panel")
        self.assertIn("Witaj w Intersophii", self.response("/panel").get_data(as_text=True))
        form_csrf = self.csrf("/panel")
        for _ in range(2):
            self.assertEqual(self.client.post("/panel", data={"csrf": form_csrf, "action": "welcome"},
                                              base_url=self.base).status_code, 303)
        self.assertIn("Panel członka koła", self.response("/panel").get_data(as_text=True))
        self.client.post("/wyloguj", data={"csrf": form_csrf}, base_url=self.base)
        self.assertEqual(self.response(link).status_code, 410)
        self.assertEqual(self.callback().location, "/panel")
        panel = self.response("/panel")
        self.assertIn("Panel członka koła", panel.get_data(as_text=True))
        self.assertEqual(panel.headers["Cache-Control"], "no-store")

    def test_wrong_or_unverified_account_does_not_spend_invite(self):
        self.response(self.invite())
        self.assertEqual(self.callback(email="wrong@gmail.com").status_code, 403)
        self.assertEqual(self.callback(email_verified=False).status_code, 403)
        self.assertEqual(self.callback().status_code, 303)

    def test_new_google_identity_without_invite_cannot_enter(self):
        self.assertEqual(self.callback().status_code, 403)
        self.assertEqual(self.response("/panel").location, "/logowanie")

    def test_annotation_session_requires_an_active_member(self):
        path = "/panel?widok=sesja-adnotacji"
        guest = self.response(path)
        self.assertEqual(guest.status_code, 401)
        self.assertEqual(guest.get_json(), {"annotations": False})
        self.member_ready()
        active = self.response(path)
        self.assertIs(active.get_json()["annotations"], True)
        self.assertEqual(active.get_json()["csrf"], self.csrf("/panel"))
        self.assertEqual(active.headers["Cache-Control"], "no-store")
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("insert into user_access values (1, 'member', ?)", (int(time.time()),))
        self.assertEqual(self.response(path).status_code, 401)

    def test_annotation_save_filters_and_private_image(self):
        author, reader = self.access_accounts()
        self.client = author
        csrf = self.csrf("/panel")
        api = "/panel?widok=adnotacje"
        image = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="
        )

        def save(**overrides):
            form = {"view": "faq:kim-jestesmy", "target": "faq:kim-jestesmy:answer", "comment": "Próba zapisu",
                    "draft": "00000000-0000-4000-8000-000000000001", "csrf": csrf, "image": (io.BytesIO(image), "test.png")}
            return self.client.post(api, data=form | overrides, base_url=self.base)

        self.assertEqual(save(csrf="wrong").status_code, 400)
        self.assertEqual(save(image=(io.BytesIO(b"<svg>"), "test.png")).status_code, 400)
        self.assertEqual(save(view="panel:access", target="access-title").status_code, 403)
        created = save()
        self.assertEqual(created.status_code, 201)
        annotation_id = created.get_json()["id"]
        self.assertEqual(save().get_json()["id"], annotation_id)
        own = self.response(api + "&zakres=faq&filtr=moje").get_json()["items"]
        self.assertEqual([entry["id"] for entry in own], [annotation_id])
        self.assertEqual(own[0]["path"], "/#kim-jestesmy")
        self.assertEqual(own[0]["comment"], "Próba zapisu")
        self.assertNotIn("image", own[0])
        self.client = reader
        self.assertEqual(self.response(api + "&zakres=faq&filtr=moje").get_json()["items"], [])
        shared = self.response(api + "&zakres=faq").get_json()["items"]
        self.assertEqual([entry["id"] for entry in shared], [annotation_id])
        self.assertEqual(shared[0]["mine"], 0)
        self.assertEqual(self.response(api + "&zakres=panel:invites").get_json()["items"], [])
        image_url = f"{api}&obraz={annotation_id}"
        fetched = self.response(image_url)
        self.assertEqual(fetched.mimetype, "image/png")
        self.assertEqual(fetched.data, image)
        self.assertEqual(fetched.headers["Cache-Control"], "no-store")
        self.client = author
        self.assertEqual(save(target="page-discord").status_code, 400)
        self.assertEqual(save(view="faq:home", target="page-discord",
                              draft="00000000-0000-4000-8000-000000000002").status_code, 201)
        self.assertEqual(save(view="faq:o-czym-rozmawiacie", target="faq:o-czym-rozmawiacie:question",
                              draft="00000000-0000-4000-8000-000000000003").status_code, 201)
        region = "region|faq:home/page-discord|faq:o-czym-rozmawiacie/faq:o-czym-rozmawiacie:question"
        self.assertEqual(save(target=region,
                              draft="00000000-0000-4000-8000-000000000004").status_code, 201)
        original_region = "region|@desktop/main/180,200,9900,8150|" + region.removeprefix("region|")
        self.assertEqual(save(target=original_region,
                              draft="00000000-0000-4000-8000-000000000006").status_code, 201)
        self.assertEqual(save(target="region|@desktop/main/0,0,10001,10000|faq:home/page-discord").status_code, 400)
        self.assertEqual(save(target="region|@desktop/main/0,0,10000,10000").status_code, 400)
        self.assertEqual(save(target="region|faq:home/unknown").status_code, 400)
        self.assertEqual(save(target="region|panel:access/access-title").status_code, 400)
        self.assertEqual(save(target="region|faq:home/page-discord|faq:home/page-discord").status_code, 400)
        self.assertEqual(save(view="panel:access", target="region|panel:access/access-title").status_code, 403)
        space = "space|main|4000,5500,8000,8700"
        self.assertEqual(save(target=space, draft="00000000-0000-4000-8000-000000000005").status_code, 201)
        self.assertEqual(save(target="space|main|8000,5500,4000,8700").status_code, 400)
        self.assertEqual(save(target="space|page|0,0,10001,10000").status_code, 400)
        self.assertEqual(save(target="space|other|0,0,10000,10000").status_code, 400)
        self.assertEqual(save(view="panel:access", target=space).status_code, 403)
        paths = {entry["target"]: entry["path"] for entry in self.response(api + "&zakres=faq").get_json()["items"]}
        self.assertEqual(paths["page-discord"], "/")
        self.assertEqual(paths["faq:o-czym-rozmawiacie:question"], "/#o-czym-rozmawiacie")
        self.assertEqual(paths[region], "/#kim-jestesmy")
        self.assertEqual(paths[original_region], "/#kim-jestesmy")
        self.assertEqual(paths[space], "/#kim-jestesmy")
        self.client = self.app.test_client()
        self.assertEqual(self.response(api + "&zakres=faq").status_code, 401)
        self.assertEqual(self.response(image_url).status_code, 401)

    def test_annotation_discussion_replies_and_role_checked_closure(self):
        author, reader = self.access_accounts()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("UPDATE users SET name='Inny członek' WHERE id=2")
            connection.executemany(
                "INSERT INTO annotations (author_id,draft_key,view,target,path,comment,image,created_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                [(1, "first", "faq:home", "brand", "/", "Uwaga", b"fixture", 1),
                 (2, "second", "faq:home", "brand", "/", "Druga uwaga", b"fixture", 1)],
            )
        first = "/panel?widok=adnotacje&watek=1"
        second = "/panel?widok=adnotacje&watek=2"

        def change(client, path, action, **data):
            self.client = client
            form = {"csrf": self.csrf("/panel"), "action": action} | data
            return client.post(path, data=form, base_url=self.base)

        first_draft = "00000000-0000-4000-8000-000000000001"
        second_draft = "00000000-0000-4000-8000-000000000002"
        fresh = author.get(first, base_url=self.base).get_json()
        self.assertFalse(fresh["has_replies"])
        self.assertTrue(fresh["can_close"])
        own = change(author, first, "reply", comment="Własna odpowiedź", draft=first_draft).get_json()
        self.assertTrue(own["has_replies"])
        self.assertEqual(change(reader, first, "close").status_code, 403)
        self.assertEqual(change(reader, first, "reply", comment="Odpowiedź członka",
                                draft=second_draft, csrf="bad").status_code, 400)
        other = change(reader, first, "reply", comment="Odpowiedź członka", draft=second_draft).get_json()
        self.assertEqual([row["author"] for row in other["replies"]], ["Ania Nowak", "Inny członek"])
        self.assertEqual([row["comment"] for row in other["replies"]], ["Własna odpowiedź", "Odpowiedź członka"])
        self.assertLess(other["replies"][0]["id"], other["replies"][1]["id"])
        self.assertGreater(other["replies"][0]["created_at"], 0)
        closed = change(author, first, "close").get_json()
        self.assertTrue(closed["closed"])
        self.assertTrue(closed["has_replies"])
        self.assertFalse(closed["can_close"])
        annotations = "/panel?widok=adnotacje&zakres=faq"
        for client in (author, reader):
            items = client.get(annotations, base_url=self.base).get_json()["items"]
            self.assertEqual([item["id"] for item in items], [2])
        self.assertEqual(author.get(annotations + "&filtr=moje", base_url=self.base).get_json()["items"], [])
        self.assertEqual(change(reader, first, "reply", comment="Spóźniona",
                                draft="00000000-0000-4000-8000-000000000003").status_code, 409)
        retry = change(reader, first, "reply", comment="Odpowiedź członka", draft=second_draft)
        self.assertEqual(retry.get_json()["replies"], closed["replies"])
        self.assertEqual(reader.get(first, base_url=self.base).get_json()["replies"], closed["replies"])
        self.assertEqual(change(author, second, "close").status_code, 403)
        self.assertEqual(self.bootstrap("tester@gmail.com").exit_code, 0)
        self.assertTrue(change(author, second, "close").get_json()["closed"])
        self.assertEqual(self.app.test_client().get(first, base_url=self.base).status_code, 401)

    def test_annotation_export_preview_permissions_and_ambiguous_retry(self):
        author, reader = self.access_accounts()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute(
                "INSERT INTO annotations (author_id,draft_key,view,target,path,comment,image,created_at) "
                "VALUES (1,'preview','faq:home','brand','/','Uwaga',?,1)",
                (b"approved-image",),
            )
        base = "/panel?widok=adnotacje&watek=1"

        def export(client, action, **fields):
            self.client = client
            return client.post(base + f"&publikacja={action}", base_url=self.base,
                               data={"csrf": self.csrf("/panel")} | fields)

        fields = {"title": "Tytuł", "summary": "Prywatny namiar test@gmail.com z <div> i @tester"}
        self.assertEqual(export(author, "preview", **fields).status_code, 409)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute(
                "INSERT INTO annotation_replies (annotation_id,author_id,draft_key,comment,created_at) "
                "VALUES (1,1,'draft','Wybrana odpowiedź',2), (1,2,'other','Pominięta odpowiedź help@gmail.com',3)"
            )
            connection.execute("INSERT INTO annotation_closures VALUES (1,1,4)")
        self.assertEqual(export(reader, "preview", **fields).status_code, 403)
        self.assertEqual(export(author, "preview", **fields, reply=[999]).status_code, 400)
        preview = export(author, "preview", **fields, reply=[1]).get_json()
        self.assertTrue(preview["proof"])
        self.assertNotIn("test@gmail.com", preview["body"])
        self.assertNotIn("@tester", preview["body"])
        self.assertNotIn("<div>", preview["body"])
        self.assertIn("Wybrana odpowiedź", preview["body"])
        self.assertNotIn("Pominięta odpowiedź", preview["body"])
        self.assertEqual(preview["draft"]["summary"], "Prywatny namiar [ukryto] z <div> i @tester")
        self.assertIsNone(preview["draft"]["title"])
        self.assertEqual(preview["draft"]["replies"][1]["comment"], "Pominięta odpowiedź [ukryto]")
        self.assertEqual(export(author, "send", proof=preview["proof"]).status_code, 503)
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM annotation_publications").fetchone()[0], 0)

        publisher = Mock()
        publisher.create.side_effect = TimeoutError
        publisher.find.side_effect = [None, 55]
        self.app.extensions["annotation_github"] = publisher
        self.assertEqual(export(author, "send", proof="tampered").status_code, 400)
        self.assertEqual(export(author, "send", proof=preview["proof"]).get_json()["state"], "checking")
        title, sent_body = publisher.create.call_args.args
        self.assertEqual(title, "Tytuł")
        self.assertTrue(sent_body.startswith(preview["body"]))
        slug = re.search(r"publiczny_wycinek=([A-Za-z0-9_-]{43})", sent_body)[1]
        image_path = f"/panel?publiczny_wycinek={slug}"
        guest = self.app.test_client()
        self.assertEqual(guest.get(image_path, base_url=self.base).status_code, 404)
        self.assertEqual(export(author, "send", proof=preview["proof"]).get_json()["state"], "checking")
        result = export(author, "check").get_json()
        self.assertEqual(result, {"state": "published", "url": "https://github.com/OtisRed/Intersophia/issues/55"})
        self.assertEqual(export(author, "send", proof=preview["proof"]).get_json(), result)
        publisher.create.assert_called_once()
        self.assertEqual(reader.get(base, base_url=self.base).get_json()["publication"], result)
        public = guest.get(image_path, base_url=self.base)
        self.assertEqual(public.mimetype, "image/png")
        self.assertEqual(public.data, b"approved-image")
        private = guest.get("/panel?widok=adnotacje&obraz=1", base_url=self.base)
        self.assertEqual(private.status_code, 401)

    def test_expired_invite_cannot_be_used_at_callback(self):
        link = self.invite()
        self.response(link)
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("update invitations set expires_at=? where digest=?",
                               (int(time.time()) - 1, digest(link.rsplit("/", 1)[1])))
        self.assertEqual(self.callback().status_code, 410)
        self.assertEqual(self.response("/panel").location, "/logowanie")

    def test_old_declaration_is_preserved_but_does_not_block_access(self):
        self.response(self.invite())
        self.callback()
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("insert into declarations values (1, 'Stare dane', 1)")
        self.assertIn("Rozumiem", self.response("/panel").get_data(as_text=True))
        form_csrf = self.csrf("/panel")
        old_form = self.client.post("/panel", data={"csrf": form_csrf, "name": "Test"}, base_url=self.base)
        self.assertEqual(old_form.status_code, 400)
        no_csrf = self.client.post("/panel", data={"action": "welcome"}, base_url=self.base)
        self.assertEqual(no_csrf.status_code, 400)
        self.client.post("/panel", data={"csrf": form_csrf, "action": "welcome"}, base_url=self.base)
        self.assertIn("Panel członka koła", self.response("/panel").get_data(as_text=True))
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("select name from declarations").fetchall(), [("Stare dane",)])
        self.assertEqual(self.app.test_client().get("/panel", base_url=self.base).location, "/logowanie")

    def member_ready(self):
        self.response(self.invite())
        self.callback()
        self.client.post("/panel", data={"csrf": self.csrf("/panel"), "action": "welcome"},
                         base_url=self.base)

    def issue_from_panel(self, email, csrf=None):
        return self.client.post("/panel", data={"action": "invite", "email": email,
                                                 "csrf": csrf or self.csrf("/panel")},
                                base_url=self.base)

    def test_member_topics_creation_voting_and_order(self):
        path = "/panel?widok=tematy"
        self.assertEqual(self.response(path).location, "/logowanie")
        self.assertEqual(self.client.post(path, data={"action": "like-topic"}, base_url=self.base).location,
                         "/logowanie")
        author, reader = self.access_accounts()
        self.client = author
        self.assertIn('aria-current="page">Tematy', self.response(path).get_data(as_text=True))
        self.assertIn("Brak zgłoszonych tematów.", self.response(path).get_data(as_text=True))

        def change(client, action, **fields):
            self.client = client
            return client.post(path, data={"csrf": self.csrf(path), "action": action} | fields, base_url=self.base)

        def draft():
            return re.search(r'name="draft" value="([^"]+)"', self.response(path).get_data(as_text=True))[1]

        first = {"draft": draft(), "title": "Pierwszy temat", "description": "Krótki opis"}
        self.assertEqual(change(author, "create-topic", **(first | {"title": "  "})).status_code, 400)
        self.assertEqual(change(author, "create-topic", **(first | {"description": "x" * 1201})).status_code, 400)
        for _ in range(2):
            self.assertEqual(change(author, "create-topic", **first).location, path)
        second = first | {"draft": draft(), "title": "Nowszy temat"}
        self.assertEqual(change(author, "create-topic", **second).location, path)
        page = self.response(path).get_data(as_text=True)
        self.assertLess(page.index("<h3>Nowszy temat</h3>"), page.index("<h3>Pierwszy temat</h3>"))
        self.assertEqual(page.count("<h3>Pierwszy temat</h3>"), 1)
        self.assertIn("Zgłasza Ania Nowak", page)

        self.assertEqual(change(reader, "like-topic", topic_id=1, csrf="wrong").status_code, 400)
        self.assertEqual(change(reader, "like-topic", topic_id=99).status_code, 404)
        for voter in (reader, reader, author):
            self.assertEqual(change(voter, "like-topic", topic_id=1).location, path)
        page = self.response(path).get_data(as_text=True)
        self.assertLess(page.index("<h3>Pierwszy temat</h3>"), page.index("<h3>Nowszy temat</h3>"))
        self.assertIn("Polubienia: 2", page)
        self.assertIn("Cofnij polubienie: Pierwszy temat", page)
        for _ in range(2):
            self.assertEqual(change(reader, "unlike-topic", topic_id=1).location, path)
        page = self.response(path).get_data(as_text=True)
        self.assertIn("Polubienia: 1", page)
        self.assertIn('aria-label="Polub: Pierwszy temat"', page)
        self.assertEqual(change(author, "unlike-topic", topic_id=1).location, path)
        page = self.response(path).get_data(as_text=True)
        self.assertLess(page.index("<h3>Nowszy temat</h3>"), page.index("<h3>Pierwszy temat</h3>"))

    def test_topic_owner_and_moderation_permissions(self):
        guardian, author = self.access_accounts()
        path = "/panel?widok=tematy"
        hidden_path = path + "&stan=ukryte"

        def post(client, action, endpoint=path, **fields):
            self.client = client
            return client.post(endpoint, data={"csrf": self.csrf(endpoint), "action": action} | fields,
                               base_url=self.base)

        def page(client, endpoint=path):
            return client.get(endpoint, base_url=self.base).get_data(as_text=True)

        draft = re.search(r'name="draft" value="([^"]+)"', page(author))[1]
        fields = {"title": "Temat autora", "description": "Krótki opis"}
        self.assertEqual(post(author, "create-topic", draft=draft, **fields).status_code, 303)
        self.assertEqual(post(guardian, "hide-topic", topic_id=1).status_code, 403)
        changes = {"topic_id": 1, "title": "Po edycji", "description": "Nowy opis"}
        self.assertEqual(post(guardian, "edit-topic", **changes).status_code, 403)
        self.assertEqual(post(guardian, "delete-topic", topic_id=1).status_code, 403)
        rejected_edit = post(author, "edit-topic", **(changes | {"title": ""}))
        self.assertEqual(rejected_edit.status_code, 400)
        self.assertIn('<details class="topic-owner-action" open>', rejected_edit.get_data(as_text=True))
        self.assertEqual(post(author, "edit-topic", **changes).status_code, 303)
        self.assertEqual(post(guardian, "like-topic", topic_id=1).status_code, 303)

        self.assertEqual(self.bootstrap("tester@gmail.com").exit_code, 0)
        self.assertEqual(post(guardian, "hide-topic", topic_id=1).status_code, 303)
        self.assertNotIn("Po edycji", page(author))
        self.assertIn("Po edycji", page(author, hidden_path))
        self.assertEqual(post(author, "like-topic", topic_id=1).status_code, 404)
        self.assertEqual(post(author, "show-topic", hidden_path, topic_id=1).status_code, 403)
        self.assertEqual(post(guardian, "show-topic", hidden_path, topic_id=1).status_code, 303)
        self.assertIn("Polubienia: 1", page(author))

        self.assertEqual(self.change_access(guardian, "grant-board", target=2).status_code, 303)
        other_draft = re.search(r'name="draft" value="([^"]+)"', page(guardian))[1]
        self.assertEqual(post(guardian, "create-topic", draft=other_draft, title="Temat Opiekuna",
                              description="Opis").status_code, 303)
        self.assertEqual(post(author, "hide-topic", topic_id=2).status_code, 303)
        self.assertIn("Temat Opiekuna", page(author, hidden_path))
        self.assertEqual(post(author, "delete-topic", hidden_path, topic_id=2).status_code, 403)
        self.assertEqual(post(author, "edit-topic", hidden_path, **(changes | {"topic_id": 2})).status_code, 403)
        self.assertEqual(post(author, "delete-topic", topic_id=1).status_code, 303)
        self.assertNotIn("Po edycji", page(guardian))
        self.assertNotIn("Po edycji", page(guardian, hidden_path))
        self.assertEqual(post(author, "show-topic", hidden_path, topic_id=1).status_code, 404)
        self.assertEqual(post(author, "create-topic", draft=draft, **fields).status_code, 303)
        self.assertNotIn("Temat autora", page(author))

    def test_topic_attachments_replace_download_and_validate(self):
        author, reader = self.access_accounts()
        path = "/panel?widok=tematy"
        reading_path = path + "&temat=1&zalacznik=reading"
        photo_path = path + "&temat=1&zalacznik=photo"
        draft = re.search(r'name="draft" value="([^"]+)"',
                          author.get(path, base_url=self.base).get_data(as_text=True))[1]
        text = {"title": "Temat z materiałem", "description": "Opis tematu"}
        photo = io.BytesIO()
        Image.new("RGB", (40, 30), "red").save(photo, "PNG")

        def post(client, action, **fields):
            self.client = client
            return client.post(path, base_url=self.base, content_type="multipart/form-data",
                               data={"csrf": self.csrf(path), "action": action} | text | fields)

        self.assertEqual(post(author, "create-topic", draft=draft, reading_url="javascript:alert(1)").status_code, 400)
        wrong = post(author, "create-topic", draft=draft, reading_url="https://example.org/lektura",
                     reading_file=(io.BytesIO(b"tekst"), "material.txt"))
        self.assertEqual(wrong.status_code, 400)
        self.assertEqual(post(author, "create-topic", draft=draft,
                              photo=(io.BytesIO(b"not an image"), "photo.png")).status_code, 400)
        self.assertEqual(post(author, "create-topic", draft=draft, reading_url="https://example.org/lektura",
                              photo=(photo, "zapowiedz.png")).status_code, 303)
        self.assertEqual(post(author, "create-topic", draft=draft,
                              reading_url="https://example.org/replay").status_code, 303)
        page = reader.get(path, base_url=self.base).get_data(as_text=True)
        self.assertIn("https://example.org/lektura", page)
        self.assertNotIn("https://example.org/replay", page)
        self.assertEqual(page.count("<h3>Temat z materiałem</h3>"), 1)
        public = self.app.test_client().get(photo_path, base_url=self.base)
        self.assertEqual(public.location, "/logowanie")
        image_response = reader.get(photo_path, base_url=self.base)
        self.assertEqual(image_response.mimetype, "image/jpeg")
        self.assertEqual(image_response.headers["Cache-Control"], "no-store")
        with Image.open(io.BytesIO(image_response.data)) as image:
            self.assertEqual(image.size, (40, 30))
        self.assertEqual(post(reader, "edit-topic", topic_id=1, remove_photo="1").status_code, 403)

        too_large = post(author, "edit-topic", topic_id=1,
                         reading_file=(io.BytesIO(b"x" * (TOPIC_FILE_LIMIT + 1)), "material.txt"))
        self.assertEqual(too_large.status_code, 400)
        pdf = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n"
        self.assertEqual(post(author, "edit-topic", topic_id=1,
                              reading_file=(io.BytesIO(pdf), "material.pdf")).status_code, 303)
        material = reader.get(reading_path, base_url=self.base)
        self.assertEqual(material.data, pdf)
        self.assertEqual(material.mimetype, "application/pdf")
        self.assertIn("attachment; filename=material.pdf", material.headers["Content-Disposition"])
        self.assertEqual(reader.get(photo_path, base_url=self.base).status_code, 200)

        self.assertEqual(self.bootstrap("tester@gmail.com").exit_code, 0)
        self.assertEqual(post(author, "hide-topic", topic_id=1).status_code, 303)
        self.assertEqual(reader.get(reading_path, base_url=self.base).status_code, 404)
        self.assertEqual(author.get(reading_path, base_url=self.base).status_code, 200)
        self.assertEqual(post(author, "edit-topic", topic_id=1, remove_reading="1", remove_photo="1").status_code, 303)
        self.assertEqual(author.get(reading_path, base_url=self.base).status_code, 404)
        self.assertEqual(author.get(photo_path, base_url=self.base).status_code, 404)

    def test_member_can_issue_invite_matching_one_gmail(self):
        self.member_ready()
        page = self.response("/panel").get_data(as_text=True)
        self.assertIn('aria-current="page">Zaproś', page)
        issued = self.issue_from_panel("New.User@gmail.com")
        self.assertEqual(issued.status_code, 200)
        link = html.unescape(re.search(r'id="invite-link" value="([^"]+)"',
                                       issued.get_data(as_text=True))[1])
        token = link.rsplit("/", 1)[1]
        self.assertNotIn(token, self.response("/panel").get_data(as_text=True))
        with closing(sqlite3.connect(self.path)) as connection:
            row = connection.execute("select email,user_id from invitations join invitation_issuers "
                                     "using(digest) where digest=?", (digest(token),)).fetchone()
            self.assertEqual(row, ("new.user@gmail.com", 1))
        self.client = self.app.test_client()
        self.assertEqual(self.response(link.removeprefix(self.base)).status_code, 303)
        self.assertEqual(self.callback(email="other@gmail.com", sub="two").status_code, 403)
        self.assertEqual(self.callback(email="new.user@gmail.com", sub="two").location, "/panel")
        self.client = self.app.test_client()
        self.assertEqual(self.response(link.removeprefix(self.base)).status_code, 410)

    def test_panel_invites_require_member_csrf_and_gmail(self):
        guest = self.client.post("/panel", data={"action": "invite", "email": "new@gmail.com"},
                                 base_url=self.base)
        self.assertEqual(guest.location, "/logowanie")
        self.member_ready()
        self.assertEqual(self.issue_from_panel("new@wp.pl").status_code, 400)
        self.assertEqual(self.issue_from_panel("new@gmail.com", csrf="wrong").status_code, 400)
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("select count(*) from invitation_issuers").fetchone(), (0,))

    def test_member_invites_have_daily_limit(self):
        self.member_ready()
        for n in range(10):
            self.assertEqual(self.issue_from_panel(f"tester{n}@gmail.com").status_code, 200)
        self.assertEqual(self.issue_from_panel("one.more@gmail.com").status_code, 429)

    def test_other_google_subject_cannot_claim_existing_account(self):
        self.response(self.invite())
        self.callback()
        self.client.post("/wyloguj", data={"csrf": self.csrf("/panel")}, base_url=self.base)
        self.response(self.invite())
        self.assertEqual(self.callback(sub="different").status_code, 403)

    def access_accounts(self):
        self.member_ready()
        guardian = self.client
        user = self.claims
        self.client = self.app.test_client()
        self.claims = user | {"email": "second@gmail.com", "sub": "two"}
        self.response(self.invite(self.claims["email"]))
        self.assertEqual(self.callback().location, "/panel")
        self.client.post("/panel", data={"csrf": self.csrf("/panel"), "action": "welcome"}, base_url=self.base)
        return guardian, self.client

    def bootstrap(self, email):
        return self.app.test_cli_runner().invoke(args=["bootstrap-guardian", email])

    def change_access(self, client, action, target=2, csrf=None):
        previous, self.client = self.client, client
        try:
            csrf = csrf or self.csrf("/panel")
        finally:
            self.client = previous
        return client.post("/panel?widok=dostep", data={
            "action": action, "user_id": target, "csrf": csrf,
        }, base_url=self.base)

    def test_roles_on_existing_accounts_and_guardian_only_management(self):
        guardian, member = self.access_accounts()
        self.assertIn("Członek SKN", self.response("/panel").get_data(as_text=True))
        self.assertNotEqual(self.bootstrap("missing@gmail.com").exit_code, 0)
        self.assertEqual(self.bootstrap("tester@gmail.com").exit_code, 0)
        self.assertEqual(self.bootstrap("tester@gmail.com").exit_code, 0)
        self.assertNotEqual(self.bootstrap("second@gmail.com").exit_code, 0)
        page = guardian.get("/panel?widok=dostep", base_url=self.base)
        self.assertEqual(page.status_code, 200)
        self.assertIn("second@gmail.com", page.get_data(as_text=True))
        self.assertEqual(self.response("/panel?widok=dostep").status_code, 403)
        self.assertEqual(self.change_access(member, "grant-board").status_code, 403)
        self.assertEqual(self.change_access(guardian, "grant-board", csrf="wrong").status_code, 400)
        self.assertEqual(self.change_access(guardian, "revoke-access", target=1).status_code, 403)
        self.assertEqual(self.change_access(guardian, "grant-board").status_code, 303)
        self.assertIn("Zarząd", self.response("/panel").get_data(as_text=True))
        self.assertEqual(self.change_access(member, "revoke-access", target=1).status_code, 403)
        self.assertEqual(self.issue_from_panel("new@gmail.com").status_code, 200)
        self.assertEqual(self.change_access(guardian, "remove-board").status_code, 303)
        self.assertIn("Członek SKN", self.response("/panel").get_data(as_text=True))
        self.assertEqual(self.issue_from_panel("another@gmail.com").status_code, 200)

    def test_revoke_denies_active_sessions_and_future_google_sign_in(self):
        guardian, member = self.access_accounts()
        self.assertEqual(self.bootstrap("tester@gmail.com").exit_code, 0)
        self.assertEqual(self.response("/panel").status_code, 200)
        csrf = self.csrf("/panel")
        old_cookie = member.get_cookie("intersophia_accounts", domain="dev.intersophia.pl")
        self.assertIsNotNone(old_cookie)
        self.assertEqual(self.change_access(guardian, "revoke-access").status_code, 303)
        self.assertEqual(self.issue_from_panel("new@gmail.com", csrf=csrf).location, "/logowanie")
        self.assertIsNone(member.get_cookie("intersophia_accounts", domain="dev.intersophia.pl"))
        member.set_cookie(old_cookie.key, old_cookie.value, domain="dev.intersophia.pl")
        self.assertEqual(self.response("/panel").location, "/logowanie")
        self.assertEqual(self.callback().status_code, 403)
        page = guardian.get("/panel?widok=dostep", base_url=self.base)
        self.assertNotIn("second@gmail.com", page.get_data(as_text=True))
        archived = guardian.get("/panel?widok=dostep&czlonkowie=usunieci", base_url=self.base).get_data(as_text=True)
        self.assertIn("second@gmail.com", archived)
        self.assertIn("Dostęp odebrany", archived)
        self.assertNotIn('value="revoke-access"', archived)
        self.assertEqual(self.response("/panel?widok=dostep&czlonkowie=usunieci").location, "/logowanie")
        self.assertEqual(self.change_access(guardian, "grant-board").status_code, 403)
        with closing(sqlite3.connect(self.path)) as connection:
            self.assertEqual(connection.execute("select count(*) from invitation_issuers").fetchone(), (0,))

    def revoke_invite(self, link, csrf=None):
        return self.client.post("/panel", data={
            "action": "revoke-invitation",
            "invitation_id": digest(link.rsplit("/", 1)[1]),
            "csrf": csrf or self.csrf("/panel"),
        }, base_url=self.base)

    def issue_link(self, email):
        response = self.issue_from_panel(email)
        self.assertEqual(response.status_code, 200)
        return html.unescape(re.search(r'id="invite-link" value="([^"]+)"',
                                       response.get_data(as_text=True))[1]).removeprefix(self.base)

    def test_invite_management_uses_current_role_and_issuer(self):
        guardian, member = self.access_accounts()
        self.assertEqual(self.bootstrap("tester@gmail.com").exit_code, 0)
        owned = self.issue_link("owned@gmail.com")
        technical = self.invite("technical@gmail.com")
        self.client = guardian
        other = self.issue_link("other@gmail.com")
        self.assertIn("owned@gmail.com", self.response("/panel").get_data(as_text=True))
        self.client = member
        page = self.response("/panel").get_data(as_text=True)
        self.assertIn("owned@gmail.com", page)
        self.assertNotIn("other@gmail.com", page)
        self.assertNotIn("technical@gmail.com", page)
        self.assertEqual(self.revoke_invite(other).status_code, 404)
        self.assertEqual(self.revoke_invite(technical).status_code, 404)
        self.assertEqual(self.revoke_invite(owned, csrf="wrong").status_code, 400)
        self.assertEqual(self.revoke_invite(owned).status_code, 303)
        self.assertEqual(self.revoke_invite(owned).status_code, 404)
        self.assertEqual(self.change_access(guardian, "grant-board").status_code, 303)
        self.assertIn("Wszystkie zaproszenia", self.response("/panel").get_data(as_text=True))
        self.assertEqual(self.revoke_invite(other).status_code, 303)
        self.assertEqual(self.change_access(guardian, "remove-board").status_code, 303)
        self.assertEqual(self.revoke_invite(technical).status_code, 404)
        self.client = guardian
        self.assertEqual(self.revoke_invite(technical).status_code, 303)

    def test_invite_statuses_and_pending_google_callback(self):
        self.member_ready()
        issuer = self.client
        previous = self.issue_link("replaced@gmail.com")
        current = self.issue_link("replaced@gmail.com")
        used = self.issue_link("used@gmail.com")
        expired = self.issue_link("expired@gmail.com")
        self.client = self.app.test_client()
        self.assertEqual(self.response(used).status_code, 303)
        self.assertEqual(self.callback(email="used@gmail.com", sub="used").status_code, 303)
        self.client = pending = self.app.test_client()
        self.assertEqual(self.response(current).status_code, 303)
        self.client = issuer
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("update invitations set expires_at=? where digest=?",
                               (int(time.time()) - 1, digest(expired.rsplit("/", 1)[1])))
        page = self.response("/panel").get_data(as_text=True)
        self.assertIn('value="active" selected', page)
        self.assertIn("replaced@gmail.com", page)
        self.assertNotIn("used@gmail.com", page)
        self.assertNotIn("expired@gmail.com", page)
        self.assertNotIn("invitation-status-revoked", page)
        self.assertEqual(page.count('value="revoke-invitation"'), 1)
        self.assertNotIn(current.rsplit("/", 1)[1], page)
        self.assertEqual(self.response("/panel?status=unknown").get_data(as_text=True), page)
        filtered = self.response("/panel?status=used").get_data(as_text=True)
        self.assertIn("used@gmail.com", filtered)
        self.assertNotIn("replaced@gmail.com", filtered)
        self.assertNotIn('value="revoke-invitation"', filtered)
        all_invites = self.response("/panel?status=all").get_data(as_text=True)
        for status in ("active", "used", "expired", "revoked"):
            self.assertIn(f"invitation-status-{status}", all_invites)
        self.assertEqual(self.revoke_invite(used).status_code, 404)
        self.assertEqual(self.revoke_invite(expired).status_code, 404)
        self.assertEqual(self.revoke_invite(current).status_code, 303)
        self.client = pending
        self.assertEqual(self.callback(email="replaced@gmail.com", sub="pending").status_code, 410)
        self.assertEqual(self.response(previous).status_code, 410)
        self.assertEqual(self.response(current).status_code, 410)
        with closing(sqlite3.connect(self.path)) as connection:
            # The old deployment ignores the new revocation table during rollback.
            self.assertLessEqual(connection.execute("select expires_at from invitations where digest=?",
                                                   (digest(current.rsplit("/", 1)[1]),)).fetchone()[0],
                                 int(time.time()))


if __name__ == "__main__":
    unittest.main()
