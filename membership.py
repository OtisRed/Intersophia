"""Invite-only member accounts for Intersophia."""
import hashlib
import os
import re
import secrets
import sqlite3
import time
from pathlib import Path

import click
from authlib.integrations.flask_client import OAuth
from authlib.integrations.base_client import OAuthError
from flask import Flask, abort, g, redirect, render_template, request, session, url_for
from werkzeug.middleware.proxy_fix import ProxyFix

GMAIL = re.compile(r"[a-z0-9][a-z0-9.]{0,62}[a-z0-9]@gmail\.com|[a-z0-9]@gmail\.com")
INVITES_PER_DAY = 10
INVITE_HOURS = 48
TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
DISCOVERY = "https://accounts.google.com/.well-known/openid-configuration"
ROLE_LABELS = {"member": "Członek SKN", "board": "Zarząd", "guardian": "Opiekun"}
INVITATION_LABELS = {"active": "Aktywne", "used": "Wykorzystane", "expired": "Wygasłe", "revoked": "Cofnięte"}
INVITATION_MANAGERS = {"board", "guardian"}
INVITATION_SCOPE = "(? OR issuer.user_id=?)"
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL
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


def create_app(settings=None):
    app = Flask(__name__, static_folder=None)
    app.config.from_mapping(
        SECRET_KEY=os.environ.get("INTERSOPHIA_SESSION_KEY"),
        DATABASE=os.environ.get("INTERSOPHIA_DB"),
        GOOGLE_CLIENT_ID=os.environ.get("GOOGLE_CLIENT_ID"),
        GOOGLE_CLIENT_SECRET=os.environ.get("GOOGLE_CLIENT_SECRET"),
        PUBLIC_ORIGIN=os.environ.get("INTERSOPHIA_ORIGIN", "https://dev.intersophia.pl"),
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
                name = str(claims.get("name") or "").strip()[:120]
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

    @app.route("/panel", methods=["GET", "POST"])
    def panel():
        user = logged_in()
        if user is None:
            return redirect(url_for("login"), code=303)
        connection = db()
        access_view = request.args.get("widok") == "dostep"
        if access_view and user["role"] != "guardian":
            abort(403)
        removed_view = request.args.get("czlonkowie") == "usunieci"
        invitation_status = request.args.get("status", "active")
        if invitation_status not in INVITATION_LABELS and invitation_status != "all":
            invitation_status = "active"
        acknowledged = connection.execute(
            "SELECT 1 FROM welcome_acknowledgements WHERE user_id=?", (user["id"],)
        ).fetchone()

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
