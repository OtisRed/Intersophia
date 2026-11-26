"""Invite-only member accounts for Intersophia."""
import hashlib
import os
import re
import secrets
import sqlite3
import struct
import time
from io import BytesIO
from pathlib import Path

import click
from authlib.integrations.flask_client import OAuth
from authlib.integrations.base_client import OAuthError
from flask import Flask, Response, abort, g, redirect, render_template, request, send_file, session, url_for
from itsdangerous import BadData, URLSafeTimedSerializer
from werkzeug.middleware.proxy_fix import ProxyFix

from github_annotations import REPO, GitHubPublisher, GitHubRejected, public_text, redact
from topic_attachments import (
    TOPIC_FILE_LIMIT, TOPIC_FILE_LIMIT_MB, TOPIC_LINK_LIMIT, TOPIC_UPLOAD_LIMIT, normalized_photo,
    parse_topic_attachments, save_topic_attachments,
)

GMAIL = re.compile(r"[a-z0-9][a-z0-9.]{0,62}[a-z0-9]@gmail\.com|[a-z0-9]@gmail\.com")
INVITES_PER_DAY = 10
INVITE_HOURS = 48
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
DISCOVERY = "https://accounts.google.com/.well-known/openid-configuration"
ROLE_LABELS = {"member": "Członek SKN", "board": "Zarząd", "guardian": "Opiekun"}
INVITATION_LABELS = {"active": "Aktywne", "used": "Wykorzystane", "expired": "Wygasłe", "revoked": "Cofnięte"}
INVITATION_MANAGERS = {"board", "guardian"}
INVITATION_SCOPE = "(? OR issuer.user_id=?)"
TOPIC_MODERATORS = {"board", "guardian"}
ANNOTATION_IMAGE_LIMIT = 512 * 1024
ANNOTATION_KEY = re.compile(r"[a-z0-9-]{1,100}")
ANNOTATION_DRAFT = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
ANNOTATION_RECT_COORDINATES = r"([0-9]{1,5}),([0-9]{1,5}),([0-9]{1,5}),([0-9]{1,5})"
ANNOTATION_SPACE = re.compile(r"space\|(?:main|header|page)\|" + ANNOTATION_RECT_COORDINATES)
ANNOTATION_REGION_RECT = re.compile(r"@(?:desktop|mobile)/(?:main|header|page)/" + ANNOTATION_RECT_COORDINATES)
FAQ_PAGE_TARGETS = {"page-facebook", "page-messenger", "page-instagram", "page-onenote",
                    "page-discord", "page-login", "page-footer"}
PANEL_HEADER_TARGETS = {"panel-home", "panel-logout"}
TOPIC_TITLE_LIMIT = 120
TOPIC_DESCRIPTION_LIMIT = 1200
MEMBER_NAME_LIMIT = 120
PROFILE_LIMITS = {"name": MEMBER_NAME_LIMIT, "study": 120, "interests": 300, "bio": 1000}
MEMBER_PROFILE_VIEWS = {"czlonkowie", "profil", "moj-profil"}
PANEL_MEMBER_TARGETS = {"member-panel", "member-nav", "member-nav-invites", "member-nav-topics",
                        "member-nav-access", "member-nav-members", "member-nav-profile"}
PANEL_ANNOTATION_TARGETS = {
    "panel:welcome": {"welcome-title", "community-rules", "welcome-acknowledge"},
    "panel:invites": {"member-panel", "member-nav", "invite-title", "invite-email-label",
                      "invite-create", "invitation-list", "invitation-filter", "member-nav-invites",
                      "member-nav-access", "invite-status-label", "invite-filter-submit"},
    "panel:access": {"member-panel", "member-nav", "access-title", "member-filter",
                     "member-nav-invites", "member-nav-access", "member-filter-active", "member-filter-removed"},
    "panel:topics": {"member-panel", "member-nav", "member-nav-invites", "member-nav-access",
                     "topics-title", "topic-title-label", "topic-description-label", "topic-create", "topic-list"},
    "panel:members": {"members-title"},
    "panel:profile": {"member-profile-back"},
    "panel:profile-edit": {"my-profile-title", "profile-save"},
}
PANEL_ANNOTATION_PATHS = {
    "panel:access": "/panel?widok=dostep", "panel:topics": "/panel?widok=tematy",
    "panel:members": "/panel?widok=czlonkowie", "panel:profile": "/panel?widok=profil",
    "panel:profile-edit": "/panel?widok=moj-profil",
}
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS member_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    study TEXT NOT NULL DEFAULT '',
    interests TEXT NOT NULL DEFAULT '',
    bio TEXT NOT NULL DEFAULT '',
    photo BLOB
);
CREATE TABLE IF NOT EXISTS annotations (
    id INTEGER PRIMARY KEY,
    author_id INTEGER NOT NULL REFERENCES users(id),
    draft_key TEXT NOT NULL,
    view TEXT NOT NULL,
    target TEXT NOT NULL,
    path TEXT NOT NULL,
    comment TEXT NOT NULL,
    image BLOB NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(author_id, draft_key)
);
CREATE INDEX IF NOT EXISTS annotations_view ON annotations(view, id);
CREATE TABLE IF NOT EXISTS annotation_replies (
    id INTEGER PRIMARY KEY,
    annotation_id INTEGER NOT NULL REFERENCES annotations(id),
    author_id INTEGER NOT NULL REFERENCES users(id),
    draft_key TEXT NOT NULL,
    comment TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(annotation_id, author_id, draft_key)
);
CREATE INDEX IF NOT EXISTS annotation_reply_order ON annotation_replies(annotation_id, id);
CREATE TABLE IF NOT EXISTS annotation_closures (
    annotation_id INTEGER PRIMARY KEY REFERENCES annotations(id),
    closed_by INTEGER NOT NULL REFERENCES users(id),
    closed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS annotation_publications (
    annotation_id INTEGER PRIMARY KEY REFERENCES annotations(id),
    public_key TEXT NOT NULL UNIQUE,
    image BLOB NOT NULL,
    requested_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('sending', 'checking', 'failed', 'published')),
    issue_number INTEGER
);
CREATE TABLE IF NOT EXISTS user_access (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('member', 'board', 'guardian')),
    revoked_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS one_guardian ON user_access(role) WHERE role='guardian';
CREATE TABLE IF NOT EXISTS invitations (
    digest TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS invitation_issuers (
    digest TEXT PRIMARY KEY REFERENCES invitations(digest),
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS invitation_issuer_time ON invitation_issuers(user_id, created_at);
CREATE TABLE IF NOT EXISTS invitation_revocations (
    digest TEXT PRIMARY KEY REFERENCES invitations(digest),
    revoked_by INTEGER NOT NULL REFERENCES users(id),
    revoked_at INTEGER NOT NULL
);
CREATE TRIGGER IF NOT EXISTS expire_revoked_invitation
AFTER INSERT ON invitation_revocations
BEGIN
    UPDATE invitations SET expires_at=MIN(expires_at, NEW.revoked_at) WHERE digest=NEW.digest;
END;
CREATE TABLE IF NOT EXISTS welcome_acknowledgements (
    user_id INTEGER PRIMARY KEY REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS meeting_topics (
    id INTEGER PRIMARY KEY,
    author_id INTEGER NOT NULL REFERENCES users(id),
    draft_key TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(author_id, draft_key)
);
CREATE TABLE IF NOT EXISTS meeting_topic_likes (
    topic_id INTEGER NOT NULL REFERENCES meeting_topics(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    PRIMARY KEY(topic_id, user_id)
);
CREATE TABLE IF NOT EXISTS meeting_topic_states (
    topic_id INTEGER PRIMARY KEY REFERENCES meeting_topics(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('hidden', 'deleted'))
);
CREATE TABLE IF NOT EXISTS meeting_topic_publications (
    topic_id INTEGER PRIMARY KEY REFERENCES meeting_topics(id) ON DELETE CASCADE,
    published_by INTEGER NOT NULL REFERENCES users(id),
    published_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meeting_topic_attachments (
    topic_id INTEGER NOT NULL REFERENCES meeting_topics(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('reading', 'photo')),
    url TEXT,
    filename TEXT,
    media_type TEXT,
    content BLOB,
    PRIMARY KEY (topic_id, kind),
    CHECK ((kind='reading' AND url IS NOT NULL AND filename IS NULL AND media_type IS NULL AND content IS NULL)
           OR (url IS NULL AND filename IS NOT NULL AND media_type IS NOT NULL AND content IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS declarations (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),
    name TEXT NOT NULL,
    submitted_at INTEGER NOT NULL
);
"""


def gmail(value):
    email = value.strip().lower() if isinstance(value, str) else ""
    return email if GMAIL.fullmatch(email) else None


def digest(token):
    return hashlib.sha256(token.encode("ascii")).hexdigest()


def annotation_path(view, target):
    if view in PANEL_ANNOTATION_TARGETS:
        if target in PANEL_HEADER_TARGETS or target in PANEL_ANNOTATION_TARGETS[view] or (
            view != "panel:welcome" and target in PANEL_MEMBER_TARGETS
        ):
            return PANEL_ANNOTATION_PATHS.get(view, "/panel")
        return None
    if view.startswith("faq:") and ANNOTATION_KEY.fullmatch(question := view[4:]):
        if question == "home" and target in FAQ_PAGE_TARGETS:
            return "/"
        if target in {"brand", "resources", "section-heading", f"faq:{question}:question", f"faq:{question}:answer"}:
            return "/" if question == "home" else f"/#{question}"
    return None


def valid_annotation_rectangle(match):
    if not match:
        return False
    left, top, right, bottom = map(int, match.groups())
    return 0 <= left < right <= 10000 and 0 <= top < bottom <= 10000


def annotation_region_path(view, target):
    path = annotation_path(view, "brand" if view.startswith("faq:") else "panel-home")
    if target.startswith("space|"):
        return path if valid_annotation_rectangle(ANNOTATION_SPACE.fullmatch(target)) else None
    if not target.startswith("region|"):
        return annotation_path(view, target)
    parts = target[7:].split("|")
    if parts[0].startswith("@") and not valid_annotation_rectangle(ANNOTATION_REGION_RECT.fullmatch(parts.pop(0))):
        return None
    if not 1 <= len(parts) <= 24 or len(set(parts)) != len(parts):
        return None
    for part in parts:
        anchor_view, _, anchor_target = part.partition("/")
        same_scope = (anchor_view.startswith("faq:") if view.startswith("faq:") else anchor_view == view)
        if not same_scope or not annotation_path(anchor_view, anchor_target):
            return None
    return path


def valid_annotation_image(image):
    if not 45 <= len(image) <= ANNOTATION_IMAGE_LIMIT:
        return False
    if not image.startswith(b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR"):
        return False
    if not image.endswith(b"\x00\x00\x00\x00IEND\xaeB\x60\x82"):
        return False
    width, height = struct.unpack_from("!II", image, 16)
    return 0 < width <= 2048 and 0 < height <= 2048 and width * height <= 2_000_000


def create_app(settings=None):
    app = Flask(__name__, static_folder=None)
    app.config.from_mapping(
        SECRET_KEY=os.environ.get("INTERSOPHIA_SESSION_KEY"),
        DATABASE=os.environ.get("INTERSOPHIA_DB"),
        GOOGLE_CLIENT_ID=os.environ.get("GOOGLE_CLIENT_ID"),
        GOOGLE_CLIENT_SECRET=os.environ.get("GOOGLE_CLIENT_SECRET"),
        PUBLIC_ORIGIN=os.environ.get("INTERSOPHIA_ORIGIN", "https://dev.intersophia.pl"),
        ANNOTATION_GITHUB_APP_ID=os.environ.get("INTERSOPHIA_GITHUB_APP_ID"),
        ANNOTATION_GITHUB_INSTALLATION_ID=os.environ.get("INTERSOPHIA_GITHUB_INSTALLATION_ID"),
        ANNOTATION_GITHUB_KEY_FILE=os.environ.get("INTERSOPHIA_GITHUB_KEY_FILE"),
        SESSION_COOKIE_NAME="intersophia_accounts",
        SESSION_COOKIE_SECURE=True,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        PERMANENT_SESSION_LIFETIME=28800,
        MAX_CONTENT_LENGTH=16 * 1024,
    )
    if settings:
        app.config.update(settings)
    if not app.secret_key or len(app.secret_key) < 32 or not app.config["DATABASE"]:
        raise RuntimeError("Configure a private session key (32+ characters) and database path")
    app_id = app.config["ANNOTATION_GITHUB_APP_ID"]
    installation_id = app.config["ANNOTATION_GITHUB_INSTALLATION_ID"]
    key_file = app.config["ANNOTATION_GITHUB_KEY_FILE"]
    if app_id and app_id.isdecimal() and installation_id and installation_id.isdecimal() and key_file:
        app.extensions["annotation_github"] = GitHubPublisher(app_id, installation_id, key_file)
    preview_signer = URLSafeTimedSerializer(app.secret_key, salt="annotation-publication-preview")
    app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1)
    oauth = OAuth(app)
    google = oauth.register(
        "google",
        client_id=app.config["GOOGLE_CLIENT_ID"],
        client_secret=app.config["GOOGLE_CLIENT_SECRET"],
        server_metadata_url=DISCOVERY,
        client_kwargs={"scope": "openid email profile", "code_challenge_method": "S256"},
    )

    def db():
        if "db" not in g:
            g.db = sqlite3.connect(app.config["DATABASE"], timeout=5)
            g.db.row_factory = sqlite3.Row
            g.db.execute("PRAGMA foreign_keys = ON")
        return g.db

    @app.teardown_appcontext
    def close_db(_error):
        connection = g.pop("db", None)
        if connection:
            connection.close()

    @app.after_request
    def private_response(response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        return response

    def csrf_token():
        if "csrf" not in session:
            session["csrf"] = secrets.token_urlsafe(32)
        return session["csrf"]

    def require_csrf():
        supplied = request.form.get("csrf", "").encode("utf-8")
        if not session.get("csrf") or not secrets.compare_digest(supplied, session["csrf"].encode("ascii")):
            abort(400)

    def account(connection, key, value):
        match = {"id": "u.id", "google_sub": "u.google_sub", "email": "u.email"}[key]
        return connection.execute(
            "SELECT u.*, COALESCE(a.role, 'member') AS role, a.revoked_at "
            f"FROM users u LEFT JOIN user_access a ON a.user_id=u.id WHERE {match}=?",
            (value,),
        ).fetchone()

    def logged_in():
        user_id = session.get("user_id")
        if not user_id:
            return None
        user = account(db(), "id", user_id)
        if user is None or user["revoked_at"] is not None:
            session.clear()
            return None
        return user

    def discussion_state(connection, annotation_id, can_manage):
        replies = connection.execute(
            "SELECT r.id,r.comment,r.created_at,COALESCE(NULLIF(u.name,''),'Członek SKN') AS author "
            "FROM annotation_replies r JOIN users u ON u.id=r.author_id "
            "WHERE r.annotation_id=? ORDER BY r.id",
            (annotation_id,),
        ).fetchall()
        closed = connection.execute(
            "SELECT 1 FROM annotation_closures WHERE annotation_id=?", (annotation_id,)
        ).fetchone() is not None
        publication = connection.execute(
            "SELECT state, issue_number FROM annotation_publications WHERE annotation_id=?", (annotation_id,)
        ).fetchone()
        return {
            "replies": [dict(reply) for reply in replies],
            "has_replies": bool(replies),
            "closed": closed,
            "can_close": can_manage and not closed,
            "can_publish": can_manage and bool(replies),
            "publication_configured": "annotation_github" in app.extensions,
            "publication": export_status(publication),
        }

    def export_status(row):
        state = row["state"] if row else "new"
        number = row["issue_number"] if row else None
        return {"state": state, "url": f"https://github.com/{REPO}/issues/{number}" if number else None}

    def public_annotation_image(public_key):
        if not TOKEN.fullmatch(public_key):
            abort(404)
        row = db().execute(
            "SELECT image FROM annotation_publications WHERE public_key=? AND state='published'", (public_key,)
        ).fetchone()
        if row is None:
            abort(404)
        return Response(row["image"], mimetype="image/png")

    def export_preview(connection, annotation, user):
        raw_title = request.form.get("title", "")
        raw_summary = request.form.get("summary", "")
        clean_title, clean_summary = redact(raw_title), redact(raw_summary)
        title = " ".join(clean_title.split())
        summary = public_text(clean_summary.strip())
        chosen = set(request.form.getlist("reply", type=int))
        replies = connection.execute(
            "SELECT id,comment FROM annotation_replies WHERE annotation_id=? ORDER BY id", (annotation["id"],)
        ).fetchall()
        if not 0 < len(title) <= 120 or not 0 < len(summary) <= 5000:
            abort(400)
        if not chosen.issubset({reply["id"] for reply in replies}):
            abort(400)
        origin = app.config["PUBLIC_ORIGIN"].rstrip("/")
        body = f"{summary}\n\nStrona: {origin}{annotation['path']}"
        context = [public_text(reply["comment"]) for reply in replies if reply["id"] in chosen]
        if context:
            body += "\n\n### Wybrane odpowiedzi\n\n" + "\n\n---\n\n".join(context)
        if len(body) > 12000:
            abort(400)
        payload = {"annotation_id": annotation["id"], "actor_id": user["id"], "title": title, "body": body}
        draft = {
            "title": clean_title if clean_title != raw_title else None,
            "summary": clean_summary if clean_summary != raw_summary else None,
            "replies": [{"id": reply["id"], "comment": redact(reply["comment"])} for reply in replies],
        }
        return {"title": title, "body": body, "proof": preview_signer.dumps(payload), "draft": draft}

    def annotation_export(connection, annotation_id):
        request.max_content_length = 64 * 1024
        require_csrf()
        action = request.args["publikacja"]
        publisher = app.extensions.get("annotation_github")
        proof = None
        if action == "send":
            try:
                proof = preview_signer.loads(request.form.get("proof", ""), max_age=900)
            except BadData:
                return {"error": "Podgląd wygasł. Przygotuj go ponownie."}, 400
        connection.execute("BEGIN IMMEDIATE" if action == "send" else "BEGIN")
        with connection:
            user = logged_in()
            if user is None:
                abort(401)
            annotation = connection.execute(
                "SELECT id,author_id,path FROM annotations WHERE id=?", (annotation_id,)
            ).fetchone()
            if annotation is None:
                abort(404)
            if user["id"] != annotation["author_id"] and user["role"] != "guardian":
                abort(403)
            if not connection.execute(
                "SELECT 1 FROM annotation_replies WHERE annotation_id=?", (annotation_id,)
            ).fetchone():
                return {"error": "Dodaj odpowiedź przed publikacją."}, 409
            if action == "preview":
                return export_preview(connection, annotation, user)
            if action not in {"send", "check"}:
                abort(400)
            if proof and (proof["annotation_id"] != annotation_id or proof["actor_id"] != user["id"]):
                abort(403)
            row = connection.execute("SELECT * FROM annotation_publications WHERE annotation_id=?",
                                     (annotation_id,)).fetchone()
            if row and row["state"] == "published":
                return export_status(row)
            if publisher is None:
                return {"error": "GitHub App nie jest jeszcze podpięta."}, 503
            create = action == "send" and (row is None or row["state"] == "failed")
            if create:
                public_key = secrets.token_urlsafe(32)
                requested_at = int(time.time())
                connection.execute(
                    "INSERT INTO annotation_publications (annotation_id,public_key,image,requested_at,state) "
                    "SELECT id,?,image,?,'sending' FROM annotations WHERE id=? "
                    "ON CONFLICT(annotation_id) DO UPDATE SET public_key=excluded.public_key,"
                    "image=excluded.image,requested_at=excluded.requested_at,state='sending'",
                    (public_key, requested_at, annotation_id),
                )
            elif row and row["state"] in {"sending", "checking"}:
                public_key, requested_at = row["public_key"], row["requested_at"]
            else:
                return export_status(row)

        marker = f"<!-- intersophia-publication:{public_key} -->"
        try:
            if create:
                image_url = app.config["PUBLIC_ORIGIN"].rstrip("/") + url_for("panel", publiczny_wycinek=public_key)
                body = f"{proof['body']}\n\n![Zatwierdzony wycinek]({image_url})\n\n{marker}"
                number = publisher.create(proof["title"], body)
            else:
                number = publisher.find(marker, requested_at)
            state = "published" if number else "checking"
        except GitHubRejected:
            number = None
            state = "failed" if create else "checking"
        except Exception:
            # The issue may have been accepted before the response was lost.
            number, state = None, "checking"
        with connection:
            connection.execute(
                "UPDATE annotation_publications SET state=?,issue_number=? WHERE annotation_id=? "
                "AND public_key=? AND state IN ('sending','checking')",
                (state, number, annotation_id, public_key),
            )
            row = connection.execute("SELECT state, issue_number FROM annotation_publications WHERE annotation_id=?",
                                     (annotation_id,)).fetchone()
        return export_status(row)

    def annotation_discussion(connection, user):
        annotation_id = request.args.get("watek", type=int)
        if not annotation_id or not 0 < annotation_id <= 2**63 - 1:
            abort(404)
        writing = request.method == "POST"
        if writing and "publikacja" in request.args:
            return annotation_export(connection, annotation_id)
        if writing:
            require_csrf()
        connection.execute("BEGIN IMMEDIATE" if writing else "BEGIN")
        with connection:
            actor = logged_in() if writing else user
            if actor is None:
                abort(401)
            annotation = connection.execute(
                "SELECT author_id FROM annotations WHERE id=?", (annotation_id,)
            ).fetchone()
            if annotation is None:
                abort(404)
            can_manage = actor["id"] == annotation["author_id"] or actor["role"] == "guardian"
            if writing:
                action = request.form.get("action")
                if action == "close":
                    if not can_manage:
                        abort(403)
                    connection.execute(
                        "INSERT INTO annotation_closures VALUES (?,?,?) ON CONFLICT(annotation_id) DO NOTHING",
                        (annotation_id, actor["id"], int(time.time())),
                    )
                elif action == "reply":
                    comment = request.form.get("comment", "").strip()
                    draft = request.form.get("draft", "")
                    if not 0 < len(comment) <= 3000 or not ANNOTATION_DRAFT.fullmatch(draft):
                        abort(400)
                    identifiers = (annotation_id, actor["id"], draft)
                    if not connection.execute(
                        "SELECT 1 FROM annotation_replies WHERE annotation_id=? AND author_id=? AND draft_key=?",
                        identifiers,
                    ).fetchone():
                        if connection.execute(
                            "SELECT 1 FROM annotation_closures WHERE annotation_id=?", (annotation_id,)
                        ).fetchone():
                            return {"error": "Dyskusja jest zamknięta."}, 409
                        connection.execute(
                            "INSERT INTO annotation_replies (annotation_id,author_id,draft_key,comment,created_at) "
                            "VALUES (?,?,?,?,?)",
                            (*identifiers, comment, int(time.time())),
                        )
                else:
                    abort(400)
            return discussion_state(connection, annotation_id, can_manage)

    def annotations(user):
        if user is None:
            abort(401)
        connection = db()
        if "watek" in request.args:
            return annotation_discussion(connection, user)
        if request.method == "POST":
            request.max_content_length = ANNOTATION_IMAGE_LIMIT + 24 * 1024
            require_csrf()
            view = request.form.get("view", "")
            target = request.form.get("target", "")
            path = annotation_region_path(view, target) if len(target) <= 4096 else None
            comment = request.form.get("comment", "").strip()
            draft = request.form.get("draft", "")
            uploaded = request.files.get("image")
            image = uploaded.read(ANNOTATION_IMAGE_LIMIT + 1) if uploaded else b""
            if not path or not 0 < len(comment) <= 3000 or not ANNOTATION_DRAFT.fullmatch(draft):
                abort(400)
            if not valid_annotation_image(image):
                abort(400)
            if view == "panel:access" and user["role"] != "guardian":
                abort(403)
            connection.execute("BEGIN IMMEDIATE")
            with connection:
                actor = logged_in()
                if actor is None:
                    abort(401)
                if view == "panel:access" and actor["role"] != "guardian":
                    abort(403)
                connection.execute(
                    "INSERT INTO annotations (author_id,draft_key,view,target,path,comment,image,created_at) "
                    "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(author_id,draft_key) DO NOTHING",
                    (actor["id"], draft, view, target, path, comment, image, int(time.time())),
                )
                annotation_id = connection.execute(
                    "SELECT id FROM annotations WHERE author_id=? AND draft_key=?", (actor["id"], draft)
                ).fetchone()["id"]
            return {"id": annotation_id}, 201

        if "obraz" in request.args:
            image_id = request.args.get("obraz", type=int)
            if not image_id or not 0 < image_id <= 2**63 - 1:
                abort(404)
            row = connection.execute("SELECT image FROM annotations WHERE id=?", (image_id,)).fetchone()
            if row is None:
                abort(404)
            return Response(row["image"], mimetype="image/png")

        scope = request.args.get("zakres", "")
        if scope not in {"faq", *PANEL_ANNOTATION_TARGETS}:
            abort(400)
        entries = connection.execute(
            "SELECT a.id,a.view,a.target,a.path,a.comment,a.created_at,"
            "COALESCE(NULLIF(u.name,''),'Członek SKN') AS author,"
            "a.author_id=? AS mine FROM annotations a JOIN users u ON u.id=a.author_id "
            "WHERE (a.view=? OR (?='faq' AND a.view LIKE 'faq:%')) AND (NOT ? OR a.author_id=?) "
            "AND NOT EXISTS (SELECT 1 FROM annotation_closures c WHERE c.annotation_id=a.id) "
            "ORDER BY a.id DESC",
            (user["id"], scope, scope, request.args.get("filtr") == "moje", user["id"]),
        )
        return {"items": [dict(row) for row in entries]}

    def invitation(connection, hashed):
        return connection.execute(
            "SELECT * FROM invitations WHERE digest=? AND used_by IS NULL AND expires_at>?",
            (hashed, int(time.time())),
        ).fetchone() if hashed else None

    def login_page(error=None, status=200):
        return render_template("login.html", error=error, csrf=csrf_token()), status

    def access_denied():
        session.clear()
        return login_page("Dostęp do panelu został odebrany.", 403)

    @app.get("/logowanie")
    def login():
        return redirect(url_for("panel")) if logged_in() else login_page()

    @app.get("/zaproszenie/<token>")
    def open_invitation(token):
        if logged_in():
            return redirect(url_for("panel"), code=303)
        session.pop("invitation", None)
        if not TOKEN.fullmatch(token) or not invitation(db(), digest(token)):
            return login_page("Ten link jest już nieważny. Poproś o nowe zaproszenie.", 410)
        session["invitation"] = digest(token)
        return redirect(url_for("login"), code=303)

    @app.post("/auth/google")
    def google_start():
        require_csrf()
        if not app.config["GOOGLE_CLIENT_ID"] or not app.config["GOOGLE_CLIENT_SECRET"]:
            return login_page("Logowanie Google nie jest jeszcze skonfigurowane.", 503)
        chosen = invitation(db(), session.get("invitation"))
        if session.get("invitation") and not chosen:
            session.pop("invitation", None)
            return login_page("Ten link jest już nieważny. Poproś o nowe zaproszenie.", 410)
        options = {"prompt": "select_account"}
        if chosen:
            options["login_hint"] = chosen["email"]
        callback = app.config["PUBLIC_ORIGIN"].rstrip("/") + url_for("google_callback")
        return google.authorize_redirect(callback, **options)

    @app.get("/auth/google/callback")
    def google_callback():
        try:
            claims = google.authorize_access_token().get("userinfo") or {}
        except (OAuthError, ValueError):
            return login_page("Nie udało się zalogować. Spróbuj ponownie.", 400)
        subject = claims.get("sub")
        email = gmail(claims.get("email"))
        if not isinstance(subject, str) or not subject or not email or claims.get("email_verified") is not True:
            return login_page("Wybierz zweryfikowane konto Gmail.", 403)
        connection = db()
        connection.execute("BEGIN IMMEDIATE")
        with connection:
            hashed = session.get("invitation")
            invite = invitation(connection, hashed)
            if hashed and not invite:
                session.pop("invitation", None)
                return login_page("Ten link jest już nieważny. Poproś o nowe zaproszenie.", 410)
            if invite and email != invite["email"]:
                return login_page("To zaproszenie jest przypisane do innego konta Gmail. Wybierz właściwe konto.", 403)
            user = account(connection, "google_sub", subject)
            if user is None:
                if not invite:
                    return login_page("Aby dołączyć, otwórz otrzymany link z zaproszeniem.", 403)
                if connection.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
                    return login_page("Ten adres jest już powiązany z innym kontem.", 403)
                name = str(claims.get("name") or "").strip()[:MEMBER_NAME_LIMIT]
                user_id = connection.execute(
                    "INSERT INTO users(google_sub,email,name) VALUES (?,?,?)", (subject, email, name)
                ).lastrowid
            else:
                if user["revoked_at"] is not None:
                    return access_denied()
                user_id = user["id"]
            if invite:
                connection.execute("UPDATE invitations SET used_by=? WHERE digest=?", (user_id, hashed))
        session.clear()
        session["user_id"] = user_id
        session.permanent = True
        return redirect(url_for("panel"), code=303)

    def new_invitation(connection, email, hours):
        token = secrets.token_urlsafe(32)
        hashed = digest(token)
        connection.execute("INSERT INTO invitations VALUES (?, ?, ?, NULL)",
                           (hashed, email, int(time.time()) + hours * 3600))
        return hashed, app.config["PUBLIC_ORIGIN"].rstrip("/") + "/zaproszenie/" + token

    def list_invitations(connection, user, status):
        return connection.execute(
            "WITH scoped AS (SELECT i.digest, i.email, u.email AS issuer_email, "
            "COALESCE(issuer.created_at, i.expires_at) AS sort_time, "
            "CASE WHEN i.used_by IS NOT NULL THEN 'used' "
            "WHEN r.digest IS NOT NULL THEN 'revoked' "
            "WHEN i.expires_at<=? THEN 'expired' ELSE 'active' END AS status "
            "FROM invitations i LEFT JOIN invitation_issuers issuer ON issuer.digest=i.digest "
            "LEFT JOIN users u ON u.id=issuer.user_id "
            "LEFT JOIN invitation_revocations r ON r.digest=i.digest "
            f"WHERE {INVITATION_SCOPE}) "
            "SELECT digest, email, issuer_email, status FROM scoped "
            "WHERE (?='all' OR status=?) ORDER BY sort_time DESC, digest",
            (int(time.time()), user["role"] in INVITATION_MANAGERS, user["id"], status, status),
        ).fetchall()

    def revoke_invitation(connection, status):
        invitation_id = request.form.get("invitation_id", "")
        if not re.fullmatch(r"[0-9a-f]{64}", invitation_id):
            abort(400)
        connection.execute("BEGIN IMMEDIATE")
        with connection:
            actor = logged_in()
            if actor is None:
                return redirect(url_for("login"), code=303)
            now = int(time.time())
            changed = connection.execute(
                "INSERT INTO invitation_revocations (digest, revoked_by, revoked_at) "
                "SELECT i.digest, ?, ? FROM invitations i "
                "LEFT JOIN invitation_issuers issuer ON issuer.digest=i.digest "
                f"WHERE {INVITATION_SCOPE} AND i.digest=? AND i.used_by IS NULL AND i.expires_at>?",
                (actor["id"], now, actor["role"] in INVITATION_MANAGERS, actor["id"], invitation_id, now),
            ).rowcount
            if not changed:
                abort(404, "Nie ma aktywnego zaproszenia, które możesz cofnąć.")
        return redirect(url_for("panel", status=status) if status != "active" else url_for("panel"), code=303)

    def manage_access(connection, action):
        target_id = request.form.get("user_id", type=int)
        if not target_id or not 0 < target_id <= 2**63 - 1:
            abort(400)
        connection.execute("BEGIN IMMEDIATE")
        with connection:
            actor = logged_in()
            if actor is None or actor["role"] != "guardian":
                abort(403)
            target = account(connection, "id", target_id)
            if target is None:
                abort(404)
            if target["role"] == "guardian" or target["revoked_at"] is not None:
                abort(403)
            role = {"grant-board": "board", "remove-board": "member"}.get(action, target["role"])
            revoked_at = int(time.time()) if action == "revoke-access" else None
            connection.execute(
                "INSERT INTO user_access (user_id, role, revoked_at) VALUES (?, ?, ?) "
                "ON CONFLICT(user_id) DO UPDATE SET role=excluded.role, revoked_at=excluded.revoked_at",
                (target_id, role, revoked_at),
            )
        return redirect(url_for("panel", widok="dostep"), code=303)

    def topics_panel(connection, user):
        topics_url = url_for("panel", widok="tematy")
        published_url = url_for("panel", widok="tematy", stan="opublikowane")
        view_state = {"ukryte": "hidden", "opublikowane": "published"}.get(request.args.get("stan"), "active")
        return_url = {
            "active": topics_url,
            "hidden": url_for("panel", widok="tematy", stan="ukryte"),
            "published": published_url,
        }[view_state]
        moderator = user["role"] in TOPIC_MODERATORS

        def view(error=None, title="", description="", draft=None, editing=None, reading_url=""):
            topics = connection.execute(
                "SELECT t.id, t.author_id, t.title, t.description, author_access.revoked_at IS NULL AS author_active, "
                "COALESCE(NULLIF(u.name,''),'Członek SKN') AS author, "
                "COUNT(l.user_id) AS likes, COALESCE(MAX(l.user_id=?), 0) AS liked, "
                "reading.url AS reading_url, reading.filename AS reading_filename, photo.filename AS photo_filename "
                "FROM meeting_topics t JOIN users u ON u.id=t.author_id "
                "LEFT JOIN user_access author_access ON author_access.user_id=t.author_id "
                "LEFT JOIN meeting_topic_likes l ON l.topic_id=t.id "
                "LEFT JOIN meeting_topic_states s ON s.topic_id=t.id "
                "LEFT JOIN meeting_topic_publications p ON p.topic_id=t.id "
                "LEFT JOIN meeting_topic_attachments reading ON reading.topic_id=t.id AND reading.kind='reading' "
                "LEFT JOIN meeting_topic_attachments photo ON photo.topic_id=t.id AND photo.kind='photo' "
                "WHERE COALESCE(s.state, CASE WHEN p.topic_id IS NULL THEN 'active' ELSE 'published' END)=? "
                "AND (?!='hidden' OR ? OR t.author_id=?) "
                "GROUP BY t.id ORDER BY p.published_at DESC, likes DESC, t.id DESC",
                (user["id"], view_state, view_state, moderator, user["id"]),
            ).fetchall()
            return render_template("member.html", topics_view=True, user=user, role_labels=ROLE_LABELS,
                                   csrf=csrf_token(), topics=topics, topic_error=error, topic_title=title,
                                   topic_description=description, topic_draft=draft or secrets.token_urlsafe(32),
                                   topic_editing=editing, topic_view_state=view_state, topic_moderator=moderator,
                                   topics_url=topics_url, topics_return_url=return_url, topics_published_url=published_url,
                                   topic_reading_url=reading_url, topic_link_limit=TOPIC_LINK_LIMIT,
                                   topic_file_limit=TOPIC_FILE_LIMIT_MB,
                                   topic_title_limit=TOPIC_TITLE_LIMIT,
                                   topic_description_limit=TOPIC_DESCRIPTION_LIMIT), 400 if error else 200

        if request.method == "GET":
            if "zalacznik" in request.args:
                topic_id = request.args.get("temat", type=int)
                kind = request.args["zalacznik"]
                if kind not in {"reading", "photo"} or not topic_id or not 0 < topic_id <= 2**63 - 1:
                    abort(404)
                attachment = connection.execute(
                    "SELECT a.filename, a.media_type, a.content FROM meeting_topic_attachments a "
                    "JOIN meeting_topics t ON t.id=a.topic_id LEFT JOIN meeting_topic_states s ON s.topic_id=t.id "
                    "WHERE a.topic_id=? AND a.kind=? AND a.filename IS NOT NULL "
                    "AND (s.state IS NULL OR (s.state='hidden' AND (? OR t.author_id=?)))",
                    (topic_id, kind, moderator, user["id"]),
                ).fetchone()
                if attachment is None:
                    abort(404)
                return send_file(BytesIO(attachment["content"]), mimetype=attachment["media_type"],
                                 download_name=attachment["filename"], as_attachment=kind == "reading",
                                 conditional=False)
            return view()

        request.max_content_length = TOPIC_UPLOAD_LIMIT
        require_csrf()
        action = request.form.get("action")
        if action not in {"create-topic", "edit-topic", "delete-topic", "hide-topic", "show-topic", "publish-topic",
                          "like-topic", "unlike-topic"}:
            abort(400)
        topic_id = request.form.get("topic_id", type=int)
        if action != "create-topic" and not (topic_id and 0 < topic_id <= 2**63 - 1):
            abort(400)
        title = request.form.get("title", "").strip()
        description = request.form.get("description", "").strip()

        def get_topic():
            topic = connection.execute(
                "SELECT t.author_id, s.state, p.topic_id IS NOT NULL AS published FROM meeting_topics t "
                "LEFT JOIN meeting_topic_states s ON s.topic_id=t.id "
                "LEFT JOIN meeting_topic_publications p ON p.topic_id=t.id WHERE t.id=?", (topic_id,),
            ).fetchone()
            if topic is None or topic["state"] == "deleted":
                abort(404)
            return topic

        draft = None
        if action == "create-topic":
            draft = request.form.get("draft", "")
            if not TOKEN.fullmatch(draft):
                abort(400)
        if action == "edit-topic":
            topic = get_topic()
            if topic["author_id"] != user["id"]:
                abort(403)
            if topic["published"]:
                abort(409, "Temat jest już opublikowany.")
        if action in {"create-topic", "edit-topic"}:
            try:
                if not 0 < len(title) <= TOPIC_TITLE_LIMIT or not 0 < len(description) <= TOPIC_DESCRIPTION_LIMIT:
                    raise ValueError("Podaj tytuł i krótki opis w podanych limitach.")
                attachments = parse_topic_attachments(request.form, request.files)
            except ValueError as error:
                return view(str(error), title[:TOPIC_TITLE_LIMIT], description[:TOPIC_DESCRIPTION_LIMIT],
                            draft, editing=topic_id if action == "edit-topic" else None,
                            reading_url=request.form.get("reading_url", "").strip()[:TOPIC_LINK_LIMIT])

        connection.execute("BEGIN IMMEDIATE")
        with connection:
            actor = logged_in()
            if actor is None:
                return redirect(url_for("login"), code=303)
            if action == "create-topic":
                created = connection.execute(
                    "INSERT INTO meeting_topics (author_id,draft_key,title,description,created_at) VALUES (?,?,?,?,?) "
                    "ON CONFLICT(author_id,draft_key) DO NOTHING",
                    (actor["id"], draft, title, description, int(time.time())),
                )
                if created.rowcount:
                    save_topic_attachments(connection, created.lastrowid, attachments)
                return redirect(topics_url, code=303)
            topic = get_topic()
            owner = topic["author_id"] == actor["id"]
            can_moderate = actor["role"] in TOPIC_MODERATORS
            if action in {"edit-topic", "delete-topic"} and not owner:
                abort(403)
            if action in {"hide-topic", "show-topic", "publish-topic"} and not can_moderate:
                abort(403)
            if action == "publish-topic":
                if topic["state"] == "hidden":
                    abort(409, "Przywróć temat przed oznaczeniem go jako opublikowany.")
                connection.execute(
                    "INSERT INTO meeting_topic_publications (topic_id,published_by,published_at) VALUES (?,?,?) "
                    "ON CONFLICT(topic_id) DO NOTHING", (topic_id, actor["id"], int(time.time())),
                )
                return redirect(published_url, code=303)
            if topic["published"]:
                abort(409, "Temat jest już opublikowany.")
            if action == "edit-topic":
                connection.execute("UPDATE meeting_topics SET title=?,description=? WHERE id=?",
                                   (title, description, topic_id))
                save_topic_attachments(connection, topic_id, attachments)
            elif action in {"hide-topic", "delete-topic"}:
                state = "hidden" if action == "hide-topic" else "deleted"
                connection.execute(
                    "INSERT INTO meeting_topic_states VALUES (?,?) "
                    "ON CONFLICT(topic_id) DO UPDATE SET state=excluded.state", (topic_id, state),
                )
                if action == "delete-topic":
                    connection.execute("DELETE FROM meeting_topic_attachments WHERE topic_id=?", (topic_id,))
            elif action == "show-topic":
                connection.execute("DELETE FROM meeting_topic_states WHERE topic_id=? AND state='hidden'",
                                   (topic_id,))
            elif topic["state"] == "hidden":
                abort(404)
            elif action == "like-topic":
                connection.execute("INSERT INTO meeting_topic_likes VALUES (?,?) ON CONFLICT DO NOTHING",
                                   (topic_id, actor["id"]))
            else:
                connection.execute("DELETE FROM meeting_topic_likes WHERE topic_id=? AND user_id=?",
                                   (topic_id, actor["id"]))
        return redirect(return_url, code=303)

    def member_profiles_panel(connection, user, panel_view):
        reading = request.method in {"GET", "HEAD"}

        def render(status=200, **details):
            return render_template("member.html", member_profile_view=panel_view, user=user, role_labels=ROLE_LABELS,
                                   csrf=csrf_token(), **details), status

        if panel_view == "czlonkowie":
            if not reading:
                abort(405)
            members = connection.execute(
                "SELECT u.id, u.name, COALESCE(a.role, 'member') AS role, "
                "p.study, p.photo IS NOT NULL AS has_photo FROM users u "
                "LEFT JOIN user_access a ON a.user_id=u.id LEFT JOIN member_profiles p ON p.user_id=u.id "
                "WHERE a.revoked_at IS NULL ORDER BY NULLIF(TRIM(u.name),'') IS NULL, u.name COLLATE NOCASE, u.id"
            ).fetchall()
            return render(members=members)

        editing = panel_view == "moj-profil"
        if editing and "czlonek" in request.args:
            abort(400)
        member_id = request.args.get("czlonek", type=int) if "czlonek" in request.args else user["id"]
        if not member_id or not 0 < member_id <= 2**63 - 1:
            abort(404)
        profile = connection.execute(
            "SELECT u.id, u.name, u.email, COALESCE(a.role, 'member') AS role, "
            "COALESCE(p.study,'') AS study, COALESCE(p.interests,'') AS interests, COALESCE(p.bio,'') AS bio, "
            "p.photo IS NOT NULL AS has_photo FROM users u LEFT JOIN user_access a ON a.user_id=u.id "
            "LEFT JOIN member_profiles p ON p.user_id=u.id WHERE u.id=? AND a.revoked_at IS NULL",
            (member_id,),
        ).fetchone()
        if profile is None:
            abort(404)
        if reading and not editing and request.args.get("zdjecie") == "1":
            photo = connection.execute(
                "SELECT p.photo FROM member_profiles p LEFT JOIN user_access a ON a.user_id=p.user_id "
                "WHERE p.user_id=? AND a.revoked_at IS NULL AND p.photo IS NOT NULL", (member_id,),
            ).fetchone()
            if photo is None:
                abort(404)
            return send_file(BytesIO(photo["photo"]), mimetype="image/jpeg", conditional=False)

        email = profile["email"] if member_id == user["id"] or user["role"] == "guardian" else None

        def profile_page(status=200, error=None, values=None):
            return render(status, profile=profile, profile_email=email, profile_error=error,
                          profile_values=values if values is not None else profile, profile_limits=PROFILE_LIMITS,
                          profile_file_limit=TOPIC_FILE_LIMIT_MB)

        if reading:
            return profile_page()
        if not editing:
            abort(405)

        request.max_content_length = TOPIC_FILE_LIMIT + 64 * 1024
        require_csrf()
        if request.form.get("action") != "save-profile":
            abort(400)
        fields = {name: request.form.get(name, "").strip() for name in PROFILE_LIMITS}
        fields["name"] = request.form.get("name", profile["name"]).strip()
        if any(len(fields[name]) > limit for name, limit in PROFILE_LIMITS.items()):
            values = {name: fields[name][:limit] for name, limit in PROFILE_LIMITS.items()}
            return profile_page(400, "Skróć pola profilu do podanych limitów.", values)
        upload = request.files.get("photo")
        try:
            photo = normalized_photo(upload, 640) if upload else None
        except ValueError as error:
            return profile_page(400, str(error), fields)

        connection.execute("BEGIN IMMEDIATE")
        with connection:
            actor = logged_in()
            if actor is None:
                return redirect(url_for("login"), code=303)
            if "name" in request.form:
                connection.execute("UPDATE users SET name=? WHERE id=?", (fields["name"], actor["id"]))
            replace_photo = bool(upload or request.form.get("remove_photo"))
            connection.execute(
                "INSERT INTO member_profiles(user_id,study,interests,bio,photo) VALUES (?,?,?,?,?) "
                "ON CONFLICT(user_id) DO UPDATE SET study=excluded.study, interests=excluded.interests, "
                "bio=excluded.bio, photo=CASE WHEN ? THEN excluded.photo ELSE member_profiles.photo END",
                (actor["id"], fields["study"], fields["interests"], fields["bio"], photo, replace_photo),
            )
        return redirect(url_for("panel", widok="profil", czlonek=actor["id"]), code=303)

    @app.route("/panel", methods=["GET", "POST"])
    def panel():
        if request.method == "GET" and "publiczny_wycinek" in request.args:
            return public_annotation_image(request.args["publiczny_wycinek"])
        user = logged_in()
        if request.args.get("widok") == "adnotacje":
            return annotations(user)
        if request.method == "GET" and request.args.get("widok") == "sesja-adnotacji":
            return {"annotations": True, "csrf": csrf_token()} if user is not None else ({"annotations": False}, 401)
        if user is None:
            return redirect(url_for("login"), code=303)
        connection = db()
        panel_view = request.args.get("widok")
        access_view = panel_view == "dostep"
        if access_view and user["role"] != "guardian":
            abort(403)
        removed_view = request.args.get("czlonkowie") == "usunieci"
        invitation_status = request.args.get("status", "active")
        if invitation_status not in INVITATION_LABELS and invitation_status != "all":
            invitation_status = "active"
        acknowledged = connection.execute(
            "SELECT 1 FROM welcome_acknowledgements WHERE user_id=?", (user["id"],)
        ).fetchone()
        if panel_view == "tematy" or panel_view in MEMBER_PROFILE_VIEWS:
            if not acknowledged:
                return redirect(url_for("panel"), code=303)
            if panel_view == "tematy":
                return topics_panel(connection, user)
            return member_profiles_panel(connection, user, panel_view)

        def view(error=None, link=None, email="", status=200):
            accounts = ()
            invites = ()
            if access_view and acknowledged:
                accounts = connection.execute(
                    "SELECT u.id, u.name, u.email, COALESCE(a.role, 'member') AS role, a.revoked_at "
                    "FROM users u LEFT JOIN user_access a ON a.user_id=u.id "
                    "WHERE (a.revoked_at IS NOT NULL)=? ORDER BY u.email",
                    (removed_view,),
                ).fetchall()
            elif acknowledged:
                invites = list_invitations(connection, user, invitation_status)
            return render_template("member.html", welcome=not acknowledged, csrf=csrf_token(),
                                   error=error, invite_link=link, invite_email=email,
                                   user=user, role_labels=ROLE_LABELS, access_view=access_view,
                                   accounts=accounts, removed_view=removed_view,
                                   invitations=invites, invitation_labels=INVITATION_LABELS,
                                   invitation_status=invitation_status,
                                   show_invitation_issuers=user["role"] in INVITATION_MANAGERS), status

        if request.method == "GET":
            return view()

        require_csrf()
        action = request.form.get("action")
        if action == "revoke-invitation":
            if not acknowledged:
                abort(403)
            return revoke_invitation(connection, invitation_status)
        if action in {"grant-board", "remove-board", "revoke-access"}:
            if not acknowledged:
                abort(403)
            return manage_access(connection, action)
        if action == "welcome":
            connection.execute("BEGIN IMMEDIATE")
            with connection:
                if logged_in() is None:
                    return redirect(url_for("login"), code=303)
                connection.execute("INSERT OR IGNORE INTO welcome_acknowledgements VALUES (?)", (user["id"],))
            return redirect(url_for("panel"), code=303)
        if action != "invite" or not acknowledged:
            abort(400)
        email = gmail(request.form.get("email"))
        if not email:
            return view("Podaj poprawny adres Gmail.", status=400)

        connection.execute("BEGIN IMMEDIATE")
        with connection:
            if logged_in() is None:
                return redirect(url_for("login"), code=303)
            now = int(time.time())
            issued = connection.execute(
                "SELECT count(*) FROM invitation_issuers WHERE user_id=? AND created_at>?",
                (user["id"], now - 86400),
            ).fetchone()[0]
            if issued >= INVITES_PER_DAY:
                return view("Limit 10 zaproszeń w ciągu 24 godzin został wykorzystany. Spróbuj później.",
                            email=email, status=429)
            # A regenerated link replaces only this member's pending link for the same Gmail.
            connection.execute(
                "INSERT INTO invitation_revocations (digest, revoked_by, revoked_at) "
                "SELECT i.digest, issuer.user_id, ? FROM invitations i "
                "JOIN invitation_issuers issuer ON issuer.digest=i.digest "
                "WHERE issuer.user_id=? AND i.email=? AND i.used_by IS NULL AND i.expires_at>?",
                (now, user["id"], email, now),
            )
            hashed, link = new_invitation(connection, email, INVITE_HOURS)
            connection.execute("INSERT INTO invitation_issuers VALUES (?, ?, ?)", (hashed, user["id"], now))
        return view(link=link, email=email)

    @app.post("/wyloguj")
    def logout():
        require_csrf()
        session.clear()
        return redirect(url_for("login"), code=303)

    @app.get("/auth/health")
    def health():
        db().execute("SELECT count(*) FROM welcome_acknowledgements").fetchone()
        db().execute("SELECT role FROM user_access LIMIT 1").fetchone()
        db().execute("SELECT digest FROM invitation_revocations LIMIT 1").fetchone()
        db().execute("SELECT id FROM annotations LIMIT 1").fetchone()
        db().execute("SELECT id FROM annotation_replies LIMIT 1").fetchone()
        db().execute("SELECT annotation_id FROM annotation_closures LIMIT 1").fetchone()
        db().execute("SELECT annotation_id FROM annotation_publications LIMIT 1").fetchone()
        db().execute("SELECT id FROM meeting_topics LIMIT 1").fetchone()
        db().execute("SELECT topic_id FROM meeting_topic_likes LIMIT 1").fetchone()
        db().execute("SELECT topic_id FROM meeting_topic_states LIMIT 1").fetchone()
        db().execute("SELECT topic_id FROM meeting_topic_publications LIMIT 1").fetchone()
        db().execute("SELECT topic_id FROM meeting_topic_attachments LIMIT 1").fetchone()
        db().execute("SELECT user_id FROM member_profiles LIMIT 1").fetchone()
        return {"status": "ok", "google_configured": bool(
            app.config["GOOGLE_CLIENT_ID"] and app.config["GOOGLE_CLIENT_SECRET"])}

    @app.cli.command("init-db")
    def init_db():
        Path(app.config["DATABASE"]).parent.mkdir(parents=True, exist_ok=True)
        db().executescript(SCHEMA)

    @app.cli.command("bootstrap-guardian")
    @click.argument("email")
    def bootstrap_guardian(email):
        email = gmail(email)
        if email is None:
            raise click.ClickException("Enter a Gmail address.")
        connection = db()
        connection.execute("BEGIN IMMEDIATE")
        with connection:
            target = account(connection, "email", email)
            if target is None or target["revoked_at"] is not None:
                raise click.ClickException("An active account for this Gmail is required.")
            if target["role"] != "guardian":
                if connection.execute("SELECT 1 FROM user_access WHERE role='guardian'").fetchone():
                    raise click.ClickException("A guardian already exists.")
                connection.execute(
                    "INSERT INTO user_access (user_id, role) VALUES (?, 'guardian') "
                    "ON CONFLICT(user_id) DO UPDATE SET role='guardian'",
                    (target["id"],),
                )
        click.echo("Guardian account verified.")

    @app.cli.command("invite")
    @click.argument("email")
    @click.option("--hours", type=click.IntRange(1, 168), default=48)
    def create_invitation(email, hours):
        email = gmail(email)
        if not email:
            raise click.ClickException("Enter a Gmail address.")
        with db():
            _, link = new_invitation(db(), email, hours)
        click.echo(link)

    return app
