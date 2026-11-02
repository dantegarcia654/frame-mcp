#!/usr/bin/env python3
"""Invite-only, Edge-only public pilot gateway for the local Frame app.

The upstream app must bind 127.0.0.1 and must not be publicly reachable.
TLS termination belongs to a trusted reverse proxy in front of this gateway.
"""
import argparse
import hashlib
import hmac
import html
import http.client
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ID = r"[a-f0-9]{32}"
ROOT = Path(__file__).resolve().parent
PROJECT = re.compile(rf"/api/frame/projects/({ID})(?:/(revise|retry))?$")
MEDIA = re.compile(rf"/frame-media/({ID})/({ID})/(export\.mp4|poster\.jpg|contact\.jpg)$")
STATIC = {"/", "/frame", "/frame.js", "/frame.css"}
MAX_BODY = 12_000
MAX_LOGIN = 1_000
SESSION_AGE = 7 * 86400
MAX_PROJECTS_PER_INVITE = 2
MAX_REVISIONS_PER_PROJECT = 2
MAX_RETRIES_PER_PROJECT = 1
LOCK = threading.RLock()


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def db_connect(path):
    con = sqlite3.connect(path, timeout=10)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires REAL NOT NULL)")
    con.execute("CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, owner TEXT NOT NULL, expires REAL NOT NULL)")
    con.execute("CREATE TABLE IF NOT EXISTS requests (owner TEXT NOT NULL, client_id TEXT NOT NULL, backend_id TEXT NOT NULL UNIQUE, project_id TEXT, PRIMARY KEY(owner,client_id))")
    con.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner TEXT NOT NULL)")
    con.execute("CREATE TABLE IF NOT EXISTS operations (owner TEXT NOT NULL, project_id TEXT NOT NULL, action TEXT NOT NULL, client_id TEXT NOT NULL, created REAL NOT NULL, PRIMARY KEY(owner,project_id,action,client_id))")
    con.commit()
    return con


def upstream(host, port, method, path, body=None, headers=None):
    con = http.client.HTTPConnection(host, port, timeout=40)
    try:
        con.request(method, path, body=body, headers=headers or {})
        response = con.getresponse()
        data = response.read()
        return response.status, {k.lower(): v for k, v in response.getheaders()}, data
    finally:
        con.close()


class PilotHandler(BaseHTTPRequestHandler):
    server_version = "FramePilot/1"

    def reply(self, code, data, mime="application/json", extra=None):
        if not isinstance(data, bytes):
            data = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'self' data:; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def owner(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            token = cookie["frame_pilot"].value
        except (KeyError, ValueError):
            return None
        with db_connect(self.server.db_path) as db:
            row = db.execute("SELECT owner FROM sessions WHERE hash=? AND expires>?", (digest(token), time.time())).fetchone()
            return row[0] if row else None

    def owns(self, owner, pid):
        with db_connect(self.server.db_path) as db:
            row = db.execute("SELECT 1 FROM projects WHERE id=? AND owner=?", (pid, owner)).fetchone()
            return bool(row)

    def safe_write(self):
        # The reverse proxy must forward Host unchanged and terminate HTTPS.
        if self.headers.get("Host") != self.server.public_host:
            return False
        if self.headers.get("Origin") != self.server.public_origin:
            return False
        if self.headers.get("Sec-Fetch-Site", "same-origin") not in ("same-origin", "none"):
            return False
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip() not in ("application/json", "application/x-www-form-urlencoded"):
            return False
        return True

    def read_body(self, limit=MAX_BODY):
        if self.headers.get("Transfer-Encoding") or not self.headers.get("Content-Length", "").isdigit():
            raise ValueError("A bounded Content-Length is required.")
        size = int(self.headers["Content-Length"])
        if not 0 < size <= limit:
            raise ValueError("Request is too large.")
        self.connection.settimeout(15)
        return self.rfile.read(size)

    def backend(self, method, path, body=None, range_header=None):
        headers = {"Host": f"127.0.0.1:{self.server.backend_port}"}
        if body is not None:
            headers.update({"Content-Type": "application/json", "Content-Length": str(len(body)),
                            "Origin": f"http://127.0.0.1:{self.server.backend_port}"})
        if range_header:
            headers["Range"] = range_header
        return upstream("127.0.0.1", self.server.backend_port, method, path, body, headers)

    def backend_reply(self, result):
        code, headers, data = result
        mime = headers.get("content-type", "application/json")
        extra = {}
        for name in ("content-range", "accept-ranges"):
            if name in headers:
                extra[name.title()] = headers[name]
        self.reply(code, data, mime, extra)

    def login_page(self):
        self.reply(200, (ROOT / "pilot-login.html").read_bytes(), "text/html; charset=utf-8")

    def do_GET(self):
        parsed = urlsplit(self.path)
        path = parsed.path
        project_query = re.fullmatch(rf"project={ID}", parsed.query)
        if self.headers.get("Host") != self.server.public_host or (parsed.query and not (path in ("/", "/frame") and project_query)):
            return self.reply(400, {"error": "Invalid address."})
        if path == "/pilot/login":
            return self.login_page()
        if path == "/pilot.css":
            return self.reply(200, (ROOT / "pilot.css").read_bytes(), "text/css; charset=utf-8")
        owner = self.owner()
        if not owner:
            return self.reply(401, {"error": "Invitation required. Open /pilot/login."})
        if path in STATIC:
            result = self.backend("GET", path)
            if path in ("/", "/frame") and result[0] == 200:
                body = result[2].decode()
                body = body.replace('<option value="fish-mcp">Fish Audio narrator</option>', '')
                body = body.replace('<nav aria-label="Other tools"><a href="/studio">Voice and reference tools</a><a href="/editor">Footage editor</a></nav>', '')
                body = body.replace('Creations are saved on this Mac.', 'Creations are saved for your pilot invitation.')
                result = (200, result[1], body.encode())
            return self.backend_reply(result)
        if path == "/api/frame/config":
            return self.reply(200, {"fish_ready": False, "voice_name": "Edge preview", "default_provider": "edge",
                                    "limits": {"script_chars": 1800, "script_words": 80, "seconds": 60},
                                    "demo_studio_id": None, "existing_studio": [],
                                    "revision_scope": "Visual direction; narration stays unchanged."})
        if path == "/api/frame/projects":
            result = self.backend("GET", path)
            if result[0] != 200:
                return self.backend_reply(result)
            try:
                rows = json.loads(result[2])
                return self.reply(200, [row for row in rows if self.owns(owner, row.get("id"))])
            except (ValueError, TypeError, AttributeError):
                return self.reply(502, {"error": "Invalid project list."})
        match = PROJECT.fullmatch(path)
        if match and not match[2] and self.owns(owner, match[1]):
            return self.backend_reply(self.backend("GET", path))
        match = MEDIA.fullmatch(path)
        if match and self.owns(owner, match[1]):
            # The upstream also verifies the version belongs to this project.
            byte_range = self.headers.get("Range")
            if byte_range and not re.fullmatch(r"bytes=\d*-\d*", byte_range):
                return self.reply(416, {"error": "Invalid range."})
            return self.backend_reply(self.backend("GET", path, range_header=byte_range))
        return self.reply(404, {"error": "Not found."})

    def do_POST(self):
        path = urlsplit(self.path).path
        if urlsplit(self.path).query or not self.safe_write():
            return self.reply(403, {"error": "Same-origin request required."})
        if path == "/pilot/login":
            try:
                raw = self.read_body(MAX_LOGIN).decode()
                from urllib.parse import parse_qs
                invite = parse_qs(raw, strict_parsing=True).get("invite", [""])[0]
                if len(invite) > 256:
                    raise ValueError("Invalid invitation.")
            except (ValueError, UnicodeError):
                return self.reply(400, {"error": "Invalid invitation."})
            with db_connect(self.server.db_path) as db:
                row = db.execute("SELECT owner FROM invites WHERE hash=? AND expires>?", (digest(invite), time.time())).fetchone()
                if not row:
                    return self.reply(403, {"error": "Invitation unavailable."})
                token = secrets.token_urlsafe(32)
                db.execute("INSERT INTO sessions VALUES(?,?,?)", (digest(token), row[0], time.time() + SESSION_AGE))
            self.send_response(303)
            self.send_header("Location", "/")
            self.send_header("Set-Cookie", f"frame_pilot={token}; Path=/; Max-Age={SESSION_AGE}; HttpOnly; Secure; SameSite=Strict")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        owner = self.owner()
        if not owner:
            return self.reply(401, {"error": "Invitation required."})
        try:
            body = json.loads(self.read_body())
            if not isinstance(body, dict):
                raise ValueError("Expected a JSON object.")
        except (ValueError, UnicodeError):
            return self.reply(400, {"error": "Invalid JSON request."})
        if path == "/api/frame/generate":
            if body.get("provider") != "edge":
                return self.reply(403, {"error": "This pilot uses the Edge preview voice only."})
            rid = body.get("request_id")
            if not isinstance(rid, str) or not re.fullmatch(r"[a-f0-9]{32}", rid):
                return self.reply(400, {"error": "Invalid request ID."})
            with LOCK:
                with db_connect(self.server.db_path) as db:
                    row = db.execute("SELECT backend_id,project_id FROM requests WHERE owner=? AND client_id=?", (owner, rid)).fetchone()
                    if row:
                        backend_id, pid = row
                    else:
                        used = db.execute("SELECT COUNT(*) FROM requests WHERE owner=?", (owner,)).fetchone()[0]
                        if used >= MAX_PROJECTS_PER_INVITE:
                            return self.reply(429, {"error": "This invitation has used its two pilot video projects."})
                        backend_id = hmac.new(self.server.secret, f"{owner}:{rid}".encode(), hashlib.sha256).hexdigest()
                        pid = None
                        db.execute("INSERT INTO requests VALUES(?,?,?,NULL)", (owner, rid, backend_id))
                body["request_id"] = backend_id
                result = self.backend("POST", path, json.dumps(body).encode())
                if result[0] == 202:
                    try:
                        returned = json.loads(result[2])["id"]
                        if not re.fullmatch(ID, returned):
                            raise ValueError("Invalid backend project.")
                    except (ValueError, KeyError, TypeError):
                        return self.reply(502, {"error": "Invalid backend response."})
                    if pid and pid != returned:
                        return self.reply(409, {"error": "Request ownership conflict."})
                    with db_connect(self.server.db_path) as db:
                        db.execute("INSERT OR IGNORE INTO projects VALUES(?,?)", (returned, owner))
                        claim = db.execute("SELECT owner FROM projects WHERE id=?", (returned,)).fetchone()[0]
                        if claim != owner:
                            return self.reply(409, {"error": "Project ownership conflict."})
                        db.execute("UPDATE requests SET project_id=? WHERE owner=? AND client_id=?", (returned, owner, rid))
                return self.backend_reply(result)
        match = PROJECT.fullmatch(path)
        if match and match[2] in ("revise", "retry") and self.owns(owner, match[1]):
            pid, action = match.groups()
            if match[2] == "revise":
                rid = body.get("request_id")
                if not isinstance(rid, str) or not re.fullmatch(r"[a-f0-9]{32}", rid):
                    return self.reply(400, {"error": "Invalid request ID."})
                body["request_id"] = hmac.new(self.server.secret, f"{owner}:{rid}".encode(), hashlib.sha256).hexdigest()
            else:
                rid = secrets.token_hex(16)
            with LOCK:
                with db_connect(self.server.db_path) as db:
                    previous = db.execute("SELECT 1 FROM operations WHERE owner=? AND project_id=? AND action=? AND client_id=?", (owner, pid, action, rid)).fetchone()
                    if not previous:
                        used = db.execute("SELECT COUNT(*) FROM operations WHERE owner=? AND project_id=? AND action=?", (owner, pid, action)).fetchone()[0]
                        limit = MAX_REVISIONS_PER_PROJECT if action == "revise" else MAX_RETRIES_PER_PROJECT
                        if used >= limit:
                            return self.reply(429, {"error": "This pilot project has reached its visual revision limit." if action == "revise" else "This pilot project has reached its retry limit."})
                        db.execute("INSERT INTO operations VALUES(?,?,?,?,?)", (owner, pid, action, rid, time.time()))
            return self.backend_reply(self.backend("POST", path, json.dumps(body).encode()))
        return self.reply(404, {"error": "Not found."})

    def log_message(self, fmt, *args):
        # Never log invitation values, session cookies, bodies or query strings.
        print(f"{self.log_date_time_string()} {self.command} {urlsplit(self.path).path} {fmt % args}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("serve", "invite", "revoke"))
    parser.add_argument("--db", required=True)
    parser.add_argument("--owner")
    parser.add_argument("--days", type=int, default=7)
    args = parser.parse_args()
    db_path = Path(args.db).resolve()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(db_path.parent, 0o700)
    with db_connect(db_path) as db:
        pass
    os.chmod(db_path, 0o600)
    if args.command == "invite":
        if not args.owner or not re.fullmatch(r"[A-Za-z0-9_-]{1,60}", args.owner) or not 1 <= args.days <= 30:
            parser.error("invite requires --owner and --days 1..30")
        code = secrets.token_urlsafe(24)
        with db_connect(db_path) as db:
            db.execute("INSERT INTO invites VALUES(?,?,?)", (digest(code), args.owner, time.time() + args.days * 86400))
        print(code)
        return
    if args.command == "revoke":
        if not args.owner or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", args.owner):
            parser.error("revoke requires an owner name of 1..64 letters, digits, underscores or hyphens")
        with db_connect(db_path) as db:
            invites = db.execute("DELETE FROM invites WHERE owner=?", (args.owner,)).rowcount
            sessions = db.execute("DELETE FROM sessions WHERE owner=?", (args.owner,)).rowcount
        print(f"revoked owner={args.owner} invites={invites} sessions={sessions}")
        return
    origin = os.environ.get("PILOT_ORIGIN", "")
    parsed = urlsplit(origin)
    if parsed.scheme != "https" or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
        parser.error("PILOT_ORIGIN must be an exact HTTPS origin")
    secret = os.environ.get("PILOT_SECRET", "")
    if len(secret) < 32:
        parser.error("PILOT_SECRET must contain at least 32 characters and remain stable")
    server = ThreadingHTTPServer((os.environ.get("PILOT_BIND", "127.0.0.1"), int(os.environ.get("PILOT_PORT", "18780"))), PilotHandler)
    server.db_path = db_path
    server.public_origin = origin
    server.public_host = parsed.netloc
    server.backend_port = int(os.environ.get("BACKEND_PORT", "8780"))
    server.secret = secret.encode()
    print(f"Frame pilot gateway listening on {server.server_address}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
