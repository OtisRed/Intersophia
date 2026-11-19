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

    def test_other_google_subject_cannot_claim_existing_account(self):
        self.response(self.invite())
        self.callback()
        self.client.post("/wyloguj", data={"csrf": self.csrf("/panel")}, base_url=self.base)
        self.response(self.invite())
        self.assertEqual(self.callback(sub="different").status_code, 403)


if __name__ == "__main__":
    unittest.main()
