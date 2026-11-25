import html
import re
import sqlite3
import tempfile
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from membership import create_app, digest


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
        self.assertEqual(active.get_json(), {"annotations": True})
        self.assertEqual(active.headers["Cache-Control"], "no-store")
        with closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("insert into user_access values (1, 'member', ?)", (int(time.time()),))
        self.assertEqual(self.response(path).status_code, 401)

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
