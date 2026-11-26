"""Publish an explicitly approved annotation to the fixed Intersophia repository."""
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from authlib.jose import jwt

REPO = "OtisRed/Intersophia"
API = "https://api.github.com"
ISSUES = f"{API}/repos/{REPO}/issues"
REDACTIONS = (
    re.compile(r"https?://[^\s<>]+", re.IGNORECASE),
    re.compile(r"[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.IGNORECASE),
    re.compile(r"\b(?:github_pat_|gh[pousr]_|ya29\.)[A-Za-z0-9_.-]+|\b[A-Za-z0-9_-]{43}\b"),
)


def redact(value):
    for pattern in REDACTIONS:
        value = pattern.sub("[ukryto]", value)
    return value


def public_text(value):
    # External issue content is plain Markdown text and does not ping users.
    escaped = re.sub(r"([\\`*_{}\[\]()#+!|])", r"\\\1", redact(value))
    return escaped.replace("<", "&lt;").replace(">", "&gt;").replace("@", "&#64;")


class GitHubRejected(Exception):
    """There was a definitive refusal, so retrying cannot duplicate the issue."""


class GitHubPublisher:
    def __init__(self, app_id, installation_id, key_file):
        self.app_id = app_id
        self.installation_id = installation_id
        self.key_file = Path(key_file)

    def app_headers(self):
        now = int(time.time())
        bearer = jwt.encode(
            {"alg": "RS256"}, {"iat": now - 30, "exp": now + 540, "iss": self.app_id},
            self.key_file.read_bytes(),
        ).decode("ascii")
        return {"Accept": "application/vnd.github+json", "Authorization": f"Bearer {bearer}",
                "X-GitHub-Api-Version": "2022-11-28"}

    def headers(self):
        try:
            headers = self.app_headers()
            response = requests.post(
                f"{API}/app/installations/{self.installation_id}/access_tokens",
                headers=headers, json={"repositories": ["Intersophia"], "permissions": {"issues": "write"}},
                timeout=8, allow_redirects=False,
            )
            if response.status_code != 201:
                raise GitHubRejected
            token = response.json()["token"]
        except (OSError, ValueError, KeyError, requests.RequestException) as error:
            raise GitHubRejected from error
        return headers | {"Authorization": f"Bearer {token}"}

    def create(self, title, body):
        response = requests.post(ISSUES, headers=self.headers(), json={"title": title, "body": body},
                                 timeout=10, allow_redirects=False)
        if response.status_code in {400, 401, 403, 404, 410, 422, 429}:
            raise GitHubRejected
        if response.status_code != 201:
            raise RuntimeError("Unknown GitHub outcome")
        number = response.json()["number"]
        if type(number) is not int or number < 1:
            raise ValueError("Invalid issue number")
        return number

    def bot_login(self):
        response = requests.get(f"{API}/app", headers=self.app_headers(), timeout=5, allow_redirects=False)
        response.raise_for_status()
        app = response.json()
        if app.get("id") != int(self.app_id) or not app.get("slug"):
            raise ValueError("Unexpected GitHub App identity")
        return f"{app['slug']}[bot]".casefold()

    def find(self, marker, requested_at):
        headers = self.headers()
        bot_login = None
        since = datetime.fromtimestamp(requested_at - 60, timezone.utc).isoformat()
        for page in range(1, 3):
            response = requests.get(
                ISSUES, headers=headers, params={"state": "all", "sort": "created", "direction": "desc",
                                                  "since": since, "per_page": 100, "page": page},
                timeout=5, allow_redirects=False,
            )
            response.raise_for_status()
            issues = response.json()
            for issue in issues:
                number = issue["number"]
                if ("pull_request" in issue or type(number) is not int or number < 1
                        or marker not in (issue.get("body") or "").splitlines()):
                    continue
                app = issue.get("performed_via_github_app")
                if app:
                    if app.get("id") == int(self.app_id):
                        return number
                    continue
                # GitHub can attribute an installation's issue only to its bot account.
                author = issue.get("user") or {}
                if author.get("type") != "Bot":
                    continue
                if bot_login is None:
                    bot_login = self.bot_login()
                if (author.get("login") or "").casefold() == bot_login:
                    return number
            if "next" not in response.links:
                return None
        return None
