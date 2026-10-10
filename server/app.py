#!/usr/bin/env python3
import base64
import hashlib
import hmac
import io
import json
import mimetypes
import os
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import tarfile
import gzip
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlparse
from cryptography.fernet import Fernet, InvalidToken


ROOT = Path(__file__).resolve().parent.parent
APP_VERSION = json.loads((ROOT / "sketch-plugin/DesignHub.sketchplugin/Contents/Sketch/manifest.json").read_text(encoding="utf-8"))["version"]
STATIC_DIR = ROOT / "server" / "static"
# 只发布安装必需的已知文件；新增插件资源时同步此白名单，禁止打包服务工作目录。
PLUGIN_DOWNLOAD_FILES = ("Contents/Sketch/manifest.json", "Contents/Sketch/script.js")
DATA_DIR = Path(os.environ.get("DESIGN_HUB_DATA_DIR", ROOT / "data")).resolve()
DB_PATH = DATA_DIR / "design-hub.sqlite3"
PROJECT_DATA_DIR = DATA_DIR / "projects"
EXPORT_CACHE_DIR = DATA_DIR / ".exports"
UPLOAD_DIR = DATA_DIR / ".uploads"
HOST = os.environ.get("DESIGN_HUB_HOST", "0.0.0.0")
PORT = int(os.environ.get("DESIGN_HUB_PORT", "8765"))
MAX_BODY_BYTES = int(os.environ.get("DESIGN_HUB_MAX_UPLOAD_MB", "150")) * 1024 * 1024
SESSION_DAYS = 7
PLUGIN_TOKEN_DAYS = 30
PASSWORD_ITERATIONS = 310_000
WRITE_LOCK = threading.RLock()

SYSTEM_ROLES = {"pending", "developer", "designer", "admin", "disabled"}
PROJECT_ROLES = {"viewer", "editor", "owner"}


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def uuid4():
    return str(uuid.uuid4())


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def hash_token(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS
    )
    return "pbkdf2_sha256${}${}${}".format(
        PASSWORD_ITERATIONS,
        base64.urlsafe_b64encode(salt).decode("ascii"),
        base64.urlsafe_b64encode(digest).decode("ascii"),
    )


def verify_password(password, encoded):
    try:
        algorithm, iterations, salt, expected = encoded.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            base64.urlsafe_b64decode(salt.encode("ascii")),
            int(iterations),
        )
        return hmac.compare_digest(
            actual, base64.urlsafe_b64decode(expected.encode("ascii"))
        )
    except (TypeError, ValueError):
        return False


def normalize_username(value):
    return value.strip().casefold()


def validate_username(value):
    username = value.strip()
    if not 3 <= len(username) <= 40:
        raise ApiError(400, "账号长度必须为 3–40 个字符")
    if not all(char.isalnum() or char in "._-" for char in username):
        raise ApiError(400, "账号只能包含字母、数字、点、下划线和连字符")
    return username


def validate_password(value):
    if not isinstance(value, str) or len(value) < 8:
        raise ApiError(400, "密码至少需要 8 个字符")
    if len(value) > 128:
        raise ApiError(400, "密码不能超过 128 个字符")
    return value


def db_connection():
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA busy_timeout = 10000")
    return connection


def init_database():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    PROJECT_DATA_DIR.mkdir(parents=True, exist_ok=True)
    with db_connection() as db:
        db.executescript(
            """
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT NOT NULL,
                username_norm TEXT NOT NULL UNIQUE,
                display_name TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('pending','developer','designer','admin','disabled')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                token_hash TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL CHECK(kind IN ('web','plugin')),
                csrf_token TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS api_keys (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                token_prefix TEXT NOT NULL,
                created_at TEXT NOT NULL,
                revoked_at TEXT
            );
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT NOT NULL DEFAULT '',
                created_by TEXT NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT
            );
            CREATE TABLE IF NOT EXISTS project_members (
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                role TEXT NOT NULL CHECK(role IN ('viewer','editor','owner')),
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(project_id, user_id)
            );
            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                name TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT,
                UNIQUE(project_id, name)
            );
            CREATE TABLE IF NOT EXISTS artboards (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
                folder_id TEXT NOT NULL REFERENCES folders(id),
                sketch_id TEXT NOT NULL,
                name TEXT NOT NULL,
                width REAL NOT NULL,
                height REAL NOT NULL,
                canvas_x REAL NOT NULL DEFAULT 0,
                canvas_y REAL NOT NULL DEFAULT 0,
                current_version_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                deleted_at TEXT,
                UNIQUE(project_id, sketch_id)
            );
            CREATE TABLE IF NOT EXISTS artboard_versions (
                id TEXT PRIMARY KEY,
                artboard_id TEXT NOT NULL REFERENCES artboards(id) ON DELETE CASCADE,
                version_no INTEGER NOT NULL,
                content_hash TEXT NOT NULL,
                metadata_path TEXT NOT NULL,
                preview_path TEXT NOT NULL,
                created_by TEXT NOT NULL REFERENCES users(id),
                created_at TEXT NOT NULL,
                UNIQUE(artboard_id, version_no)
            );
            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                version_id TEXT NOT NULL REFERENCES artboard_versions(id) ON DELETE CASCADE,
                layer_id TEXT,
                name TEXT NOT NULL,
                kind TEXT NOT NULL,
                format TEXT NOT NULL,
                scale REAL NOT NULL DEFAULT 1,
                file_path TEXT NOT NULL,
                width REAL,
                height REAL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                actor_id TEXT REFERENCES users(id),
                action TEXT NOT NULL,
                object_type TEXT NOT NULL,
                object_id TEXT,
                details_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
            CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id, revoked_at);
            CREATE INDEX IF NOT EXISTS idx_members_user ON project_members(user_id);
            CREATE INDEX IF NOT EXISTS idx_folders_project ON folders(project_id, deleted_at);
            CREATE INDEX IF NOT EXISTS idx_artboards_folder ON artboards(folder_id, deleted_at);
            CREATE INDEX IF NOT EXISTS idx_versions_artboard ON artboard_versions(artboard_id, version_no DESC);
            CREATE INDEX IF NOT EXISTS idx_assets_version ON assets(version_id);
            """
        )
        columns = {row[1] for row in db.execute("PRAGMA table_info(artboards)")}
        if "canvas_x" not in columns:
            db.execute("ALTER TABLE artboards ADD COLUMN canvas_x REAL NOT NULL DEFAULT 0")
        if "canvas_y" not in columns:
            db.execute("ALTER TABLE artboards ADD COLUMN canvas_y REAL NOT NULL DEFAULT 0")
        columns = {row[1] for row in db.execute("PRAGMA table_info(api_keys)")}
        if "purpose" not in columns:
            db.execute("ALTER TABLE api_keys ADD COLUMN purpose TEXT NOT NULL DEFAULT ''")
        if "encrypted_token" not in columns:
            db.execute("ALTER TABLE api_keys ADD COLUMN encrypted_token TEXT")
        columns = {row[1] for row in db.execute("PRAGMA table_info(audit_logs)")}
        if "project_id" not in columns:
            db.execute("ALTER TABLE audit_logs ADD COLUMN project_id TEXT")
            db.execute("UPDATE audit_logs SET project_id=object_id WHERE object_type='project'")
            db.execute("UPDATE audit_logs SET project_id=substr(object_id,1,36) WHERE object_type='project_member'")
            db.execute("UPDATE audit_logs SET project_id=(SELECT project_id FROM artboards WHERE id=audit_logs.object_id) WHERE object_type='artboard'")
        db.execute("CREATE INDEX IF NOT EXISTS idx_audit_project_id ON audit_logs(project_id,id)")


def ensure_initial_admin():
    with db_connection() as db:
        if db.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            return
        username = os.environ.get("DESIGN_HUB_ADMIN_USERNAME", "admin")
        password = os.environ.get("DESIGN_HUB_ADMIN_PASSWORD")
        if not password:
            raise RuntimeError(
                "首次启动需要设置 DESIGN_HUB_ADMIN_PASSWORD（至少 8 个字符）"
            )
        username = validate_username(username)
        password = validate_password(password)
        now = utc_now()
        db.execute(
            """INSERT INTO users
               (id, username, username_norm, display_name, password_hash, role, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'admin', ?, ?)""",
            (uuid4(), username, normalize_username(username), "Admin", hash_password(password), now, now),
        )


def public_user(row):
    return {
        "id": row["id"],
        "username": row["username"],
        "display_name": row["display_name"],
        "role": row["role"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def create_session(db, user_id, kind):
    token = secrets.token_urlsafe(36)
    csrf = secrets.token_urlsafe(24)
    days = PLUGIN_TOKEN_DAYS if kind == "plugin" else SESSION_DAYS
    expires_at = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat(
        timespec="seconds"
    )
    db.execute(
        """INSERT INTO sessions
           (id, user_id, token_hash, kind, csrf_token, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (uuid4(), user_id, hash_token(token), kind, csrf, expires_at, utc_now()),
    )
    return token, csrf, expires_at


def project_role(db, user, project_id):
    if user["role"] == "admin":
        return "admin"
    row = db.execute(
        "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
        (project_id, user["id"]),
    ).fetchone()
    return ("viewer" if user["role"] == "developer" else row["role"]) if row else None


def require_project_role(db, user, project_id, allowed, include_deleted=False):
    role = project_role(db, user, project_id)
    if role not in allowed:
        raise ApiError(403, "没有该项目的操作权限")
    project = db.execute("SELECT deleted_at FROM projects WHERE id=?", (project_id,)).fetchone()
    if not project or (project["deleted_at"] and not include_deleted):
        raise ApiError(404, "项目不存在或已移入回收站")
    return role


def audit(db, actor_id, action, object_type, object_id=None, details=None):
    details = details or {}
    project_id = details.get("project_id")
    if object_type == "project":
        project_id = object_id
    elif object_type == "project_member":
        project_id = str(object_id).split(":")[0]
    elif object_type == "artboard":
        row = db.execute("SELECT project_id FROM artboards WHERE id=?", (object_id,)).fetchone()
        project_id = row[0] if row else project_id
    db.execute(
        """INSERT INTO audit_logs
           (actor_id, action, object_type, object_id, details_json, created_at, project_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        (actor_id, action, object_type, object_id, canonical_json(details), utc_now(), project_id),
    )


def key_cipher(db):
    path = DATA_DIR / '.key-encryption.key'
    if not path.exists():
        # 丢失主密钥时禁止生成替代密钥；已有密文必须通过备份恢复。
        if db.execute("SELECT 1 FROM api_keys WHERE encrypted_token IS NOT NULL LIMIT 1").fetchone():
            raise ApiError(503, "Key 加密密钥缺失，请管理员恢复备份")
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as handle:
            handle.write(Fernet.generate_key())
    return Fernet(path.read_bytes())


def decode_file(value, label):
    if not value:
        return b""
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise ApiError(400, f"{label} 不是有效的 Base64 数据")


def safe_format(value):
    value = str(value or "bin").lower().lstrip(".")
    return value if value in {"png", "jpg", "jpeg", "svg", "webp", "pdf"} else "bin"


def ai_layout(metadata, assets, width, height):
    root = metadata.get("artboard", metadata)
    asset_map = {}
    for asset in assets:
        asset_map.setdefault(str(asset["layer_id"] or ""), []).append(
            {
                "id": asset["id"],
                "name": asset["name"],
                "kind": asset["kind"],
                "format": asset["format"],
                "scale": asset["scale"],
                "width": asset["width"],
                "height": asset["height"],
                "download_url": f"/api/assets/{asset['id']}/download",
            }
        )
    layers = []

    def visit(layer, parent_x=0.0, parent_y=0.0, parent_id=None, depth=0):
        frame = layer.get("frame") or {}
        x = parent_x + float(frame.get("x") or 0)
        y = parent_y + float(frame.get("y") or 0)
        layer_id = str(layer.get("id") or layer.get("objectID") or layer.get("var") or f"layer-{len(layers)}")
        layers.append(
            {
                "id": layer_id,
                "parent_id": parent_id,
                "depth": depth,
                "name": str(layer.get("name") or "未命名"),
                "type": str(layer.get("type") or layer.get("_class") or "Layer"),
                "frame": {
                    "x": x,
                    "y": y,
                    "width": float(frame.get("width") or 0),
                    "height": float(frame.get("height") or 0),
                },
                "rotation": layer.get("rotation") or 0,
                "hidden": bool(layer.get("hidden")),
                "locked": bool(layer.get("locked")),
                "is_mask": bool(layer.get("isMask")),
                "clips_content": bool(layer.get("clipsContent")),
                "constraints": {
                    "horizontal_sizing": layer.get("horizontalSizing"),
                    "vertical_sizing": layer.get("verticalSizing"),
                    "horizontal_pins": layer.get("horizontalPins"),
                    "vertical_pins": layer.get("verticalPins"),
                },
                "text": layer.get("text"),
                "style": layer.get("style") or {},
                "assets": asset_map.get(layer_id, []),
            }
        )
        for child in layer.get("layers") or layer.get("children") or []:
            visit(child, x, y, layer_id, depth + 1)

    for child in root.get("layers") or root.get("children") or []:
        visit(child)
    top_pattern = re.compile(r"status\s*bar|navigation\s*bar|nav\s*bar|app\s*bar|top\s*bar|状态栏|导航栏", re.I)
    bottom_pattern = re.compile(r"tab\s*bar|bottom\s*(?:bar|navigation)|home\s*indicator|标签栏|底部导航", re.I)
    visible = [layer for layer in layers if not layer["hidden"] and layer["frame"]["width"] > 1 and layer["frame"]["height"] > 1]
    top = [layer for layer in visible if layer["frame"]["y"] < height * 0.35 and top_pattern.search(layer["name"])]
    bottom = [layer for layer in visible if layer["frame"]["y"] + layer["frame"]["height"] > height * 0.65 and bottom_pattern.search(layer["name"])]
    content_top = max((layer["frame"]["y"] + layer["frame"]["height"] for layer in top), default=0)
    content_bottom = min((layer["frame"]["y"] for layer in bottom), default=height)
    for layer in layers:
        layer["frame"]["content_y"] = layer["frame"]["y"] - content_top
    device_class = "small_phone" if width <= 375 else "regular_phone" if width < 768 else "large_screen"
    return {
        "coordinate_space": {"unit": "pt", "origin": "artboard_top_left", "width": width, "height": height},
        "device_class": device_class,
        "regions": {
            "top_system": [{"id": item["id"], "name": item["name"], "frame": item["frame"]} for item in top],
            "content": {"x": 0, "y": content_top, "width": width, "height": max(0, content_bottom - content_top)},
            "bottom_system": [{"id": item["id"], "name": item["name"], "frame": item["frame"]} for item in bottom],
        },
        "responsive_rules": {
            "small_phone": "width <= 375pt; preserve safe-area insets and compress flexible spacing first",
            "regular_phone": "width 390-430pt; use reference relative spacing",
            "large_screen": "width >= 768pt; center content with a suitable max width",
            "text_scale": "dynamic single-line numbers may scale to 0.5; ordinary labels and buttons may scale to 0.7",
        },
        "layers": layers,
    }


class DesignHubHandler(BaseHTTPRequestHandler):
    server_version = f"DesignHub/{APP_VERSION}"

    def log_message(self, fmt, *args):
        sys.stdout.write(
            "{} [HTTP] {}\n".format(datetime.now().isoformat(timespec="seconds"), fmt % args)
        )
        sys.stdout.flush()

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def _dispatch(self, method):
        self._audit_user = None
        self._audit_status = 500
        self._audit_kind = None
        try:
            parsed = urlparse(self.path)
            path = parsed.path.rstrip("/") or "/"
            query = parse_qs(parsed.query)
            if path == "/api/health" and method == "GET":
                return self._json(200, {"status": "ok", "service": "design-hub", "version": APP_VERSION})
            if path == "/api/integrations" and method == "GET":
                manifest = json.loads(self._integration_source("sketch-plugin/DesignHub.sketchplugin/Contents/Sketch/manifest.json"))
                self._integration_source("sketch-plugin/DesignHub.sketchplugin/Contents/Sketch/script.js")
                self._integration_source("design_hub_mcp.py")
                return self._json(200, {
                    "sketch": {"version": manifest["version"], "compatible_version": manifest.get("compatibleVersion"), "download_url": "/downloads/DesignHub.sketchplugin.zip"},
                    "mcp": {"transport": "stdio", "download_url": "/downloads/design_hub_mcp.py", "npm_download_url": f"/downloads/design-hub-mcp-{APP_VERSION}.tgz", "version": APP_VERSION},
                })
            if path.startswith("/downloads/"):
                if method != "GET":
                    raise ApiError(405, "下载仅支持 GET")
                return self._download_integration(path)
            if path == "/api/register" and method == "POST":
                return self._register()
            if path == "/api/login" and method == "POST":
                return self._login("web")
            if path == "/api/plugin/login" and method == "POST":
                return self._login("plugin")
            if len([part for part in path.split("/") if part]) == 3 and path.startswith("/ai/artboards/") and method == "GET":
                artboard_id = path.rsplit("/", 1)[-1]
                return self._json(200, {
                    "service": "Design Hub", "schema_version": "1.0", "artboard_id": artboard_id,
                    "openapi_url": "/openapi.json", "documentation_url": "/docs", "llms_txt": "/llms.txt",
                    "authentication": {"type": "http_bearer", "header": "Authorization", "format": "Bearer dhk_xxx"},
                    "ai_context_url": f"/api/artboards/{artboard_id}/ai-context",
                })

            if path.startswith("/api/"):
                user, session = self._authenticate()
                self._audit_user = user["id"]
                self._audit_kind = session["kind"]
                if method in {"POST", "PATCH", "DELETE"}:
                    self._check_csrf(session)
                return self._api(method, path, query, user, session)
            return self._static(path)
        except ApiError as error:
            return self._json(error.status, {"error": error.message})
        except Exception as error:
            self.log_error("Unhandled error: %r", error)
            return self._json(500, {"error": "服务处理请求失败"})
        finally:
            self._record_request(method)

    def send_response(self, code, message=None):
        self._audit_status = code
        super().send_response(code, message)

    def _record_request(self, method):
        path = urlparse(self.path).path.rstrip('/')
        if not path.startswith('/api/') or path in {'/api/health','/api/integrations','/api/me','/api/audit'}:
            return
        parts = path.strip('/').split('/')
        # 不记录 body、查询参数、Authorization、Key 原文；未知路径片段不写入日志。
        route_words = {'api','projects','folders','artboards','versions','assets','uploads','upload','chunk','commit','cancel','members','users','api-keys','login','plugin','logout','register','restore','purge','preview','download','export','exports','package','ai-context','recycle'}
        safe_path = '/' + '/'.join(p if p in route_words or re.fullmatch(r'[0-9a-f-]{36}',p) else '[invalid]' for p in parts)
        try:
            with WRITE_LOCK, db_connection() as db:
                project_id = None
                if len(parts) >= 3:
                    identifier = parts[2]
                    if parts[1] == 'projects' and re.fullmatch(r'[0-9a-f-]{36}',identifier):
                        project_id = identifier
                    elif parts[1] in {'artboards','versions','assets'}:
                        sql = {
                            'artboards':'SELECT project_id FROM artboards WHERE id=?',
                            'versions':'SELECT a.project_id FROM artboard_versions v JOIN artboards a ON a.id=v.artboard_id WHERE v.id=?',
                            'assets':'SELECT a.project_id FROM assets s JOIN artboard_versions v ON v.id=s.version_id JOIN artboards a ON a.id=v.artboard_id WHERE s.id=?',
                        }[parts[1]]
                        row = db.execute(sql,(identifier,)).fetchone()
                        project_id = row[0] if row else None
                audit(db,self._audit_user,'request.'+method,'request',safe_path,{'status':self._audit_status,'auth_kind':self._audit_kind,'project_id':project_id})
        except Exception:
            self.log_error('Audit write failed')

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ApiError(400, "Content-Length 无效")
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ApiError(413, "上传内容超过服务端限制")
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ApiError(400, "请求 JSON 无效")

    def _json(self, status, payload, headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def _static(self, path):
        filename = "docs.html" if path == "/docs" else "index.html" if path == "/" else unquote(path.lstrip("/"))
        target = (STATIC_DIR / filename).resolve()
        if STATIC_DIR not in target.parents and target != STATIC_DIR:
            raise ApiError(404, "页面不存在")
        if not target.is_file():
            target = STATIC_DIR / "index.html"
        body = target.read_bytes()
        artboard_match = re.match(r"^/projects/[^/]+/artboards/([^/]+)$", path)
        if target.name == "index.html" and artboard_match:
            body = body.replace(
                b'id="ai-context-link" rel="alternate"',
                f'id="ai-context-link" rel="alternate" href="/api/artboards/{artboard_match.group(1)}/ai-context"'.encode("utf-8"),
                1,
            )
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", f"{mime}; charset=utf-8" if mime.startswith("text/") else mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        links = ['</openapi.json>; rel="service-desc"; type="application/vnd.oai.openapi+json"', '</llms.txt>; rel="describedby"; type="text/plain"']
        if artboard_match:
            links.append(f'</api/artboards/{artboard_match.group(1)}/ai-context>; rel="alternate"; type="application/json"')
        self.send_header("Link", ", ".join(links))
        self.end_headers()
        self.wfile.write(body)

    def _integration_source(self, relative_path):
        source = ROOT / relative_path
        # 不跟随到仓库外，也不允许把链接目标伪装成公开安装文件。
        if source.is_symlink() or not source.is_file() or ROOT.resolve() not in source.resolve().parents:
            raise ApiError(404, "安装文件暂不可用，请联系管理员检查部署文件")
        return source.read_bytes()

    def _download_integration(self, path):
        if path == f"/downloads/design-hub-mcp-{APP_VERSION}.tgz":
            archive = io.BytesIO()
            # 固定包内容与时间戳，不调用 npm、不打包仓库/凭据，客户端无需公网依赖。
            with gzip.GzipFile(fileobj=archive, mode="wb", mtime=0) as compressed:
                with tarfile.open(fileobj=compressed, mode="w") as bundle:
                    for name in ("package.json", "cli.cjs"):
                        source = self._integration_source(f"mcp-node/{name}")
                        if name == "package.json" and json.loads(source)["version"] != APP_VERSION:
                            raise ApiError(503, "MCP 包版本与服务版本不一致")
                        entry = tarfile.TarInfo(f"package/{name}")
                        entry.size = len(source)
                        entry.mode = 0o755 if name == "cli.cjs" else 0o644
                        bundle.addfile(entry, io.BytesIO(source))
            return self._download_bytes(archive.getvalue(), f"design-hub-mcp-{APP_VERSION}.tgz")
        if path == "/downloads/design_hub_mcp.py":
            return self._download_bytes(self._integration_source("design_hub_mcp.py"), "design_hub_mcp.py")
        if path == "/downloads/DesignHub.sketchplugin.zip":
            archive = io.BytesIO()
            with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
                for relative in PLUGIN_DOWNLOAD_FILES:
                    source = self._integration_source(f"sketch-plugin/DesignHub.sketchplugin/{relative}")
                    bundle.writestr(f"DesignHub.sketchplugin/{relative}", source)
            return self._download_bytes(archive.getvalue(), "DesignHub.sketchplugin.zip")
        raise ApiError(404, "下载文件不存在")

    def _register(self):
        data = self._read_json()
        username = validate_username(str(data.get("username", "")))
        password = validate_password(data.get("password"))
        display_name = str(data.get("display_name", "")).strip() or username
        if len(display_name) > 60:
            raise ApiError(400, "姓名不能超过 60 个字符")
        now = utc_now()
        try:
            with WRITE_LOCK, db_connection() as db:
                user_id = uuid4()
                db.execute(
                    """INSERT INTO users
                       (id, username, username_norm, display_name, password_hash, role, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)""",
                    (user_id, username, normalize_username(username), display_name, hash_password(password), now, now),
                )
                audit(db, user_id, "user.register", "user", user_id)
        except sqlite3.IntegrityError:
            raise ApiError(409, "账号已存在")
        return self._json(201, {"status": "pending", "message": "注册成功，等待管理员审核"})

    def _login(self, kind):
        data = self._read_json()
        username = normalize_username(str(data.get("username", "")))
        password = str(data.get("password", ""))
        with WRITE_LOCK, db_connection() as db:
            user = db.execute("SELECT * FROM users WHERE username_norm = ?", (username,)).fetchone()
            if not user or not verify_password(password, user["password_hash"]):
                raise ApiError(401, "账号或密码错误")
            if user["role"] == "disabled":
                raise ApiError(403, "账号已被禁用")
            token, csrf, expires_at = create_session(db, user["id"], kind)
            self._audit_user = user["id"]
            self._audit_kind = kind
            audit(db, user["id"], "session.login", "session", details={"kind": kind})
        payload = {
            "user": public_user(user),
            "csrf_token": csrf,
            "expires_at": expires_at,
        }
        if kind == "plugin":
            payload["token"] = token
            return self._json(200, payload)
        cookie = f"dh_session={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_DAYS * 86400}"
        return self._json(200, payload, {"Set-Cookie": cookie})

    def _authenticate(self):
        token = None
        kind = None
        authorization = self.headers.get("Authorization", "")
        if authorization.startswith("Bearer "):
            token = authorization[7:].strip()
            kind = "api_key" if token.startswith("dhk_") else "plugin"
        else:
            cookie = SimpleCookie(self.headers.get("Cookie", ""))
            if "dh_session" in cookie:
                token = cookie["dh_session"].value
                kind = "web"
        if not token:
            raise ApiError(401, "请先登录")
        if kind == "api_key":
            with db_connection() as db:
                row = db.execute(
                    """SELECT api_keys.id, api_keys.user_id, users.username, users.display_name, users.role,
                              users.created_at AS user_created_at, users.updated_at AS user_updated_at
                       FROM api_keys JOIN users ON users.id = api_keys.user_id
                       WHERE api_keys.token_hash = ? AND api_keys.revoked_at IS NULL""",
                    (hash_token(token),),
                ).fetchone()
            if not row:
                raise ApiError(401, "API Key 无效或已撤销")
            if row["role"] == "disabled":
                raise ApiError(403, "账号已被禁用")
            user = {
                "id": row["user_id"], "username": row["username"], "display_name": row["display_name"],
                "role": row["role"], "created_at": row["user_created_at"], "updated_at": row["user_updated_at"],
            }
            return user, {"id": row["id"], "kind": "api_key", "csrf_token": ""}
        with db_connection() as db:
            row = db.execute(
                """SELECT sessions.*, users.username, users.display_name, users.role,
                          users.created_at AS user_created_at, users.updated_at AS user_updated_at
                   FROM sessions JOIN users ON users.id = sessions.user_id
                   WHERE sessions.token_hash = ? AND sessions.expires_at > ?""",
                (hash_token(token), utc_now()),
            ).fetchone()
        if not row or row["kind"] != kind:
            raise ApiError(401, "登录已失效")
        if row["role"] == "disabled":
            raise ApiError(403, "账号已被禁用")
        user = {
            "id": row["user_id"],
            "username": row["username"],
            "display_name": row["display_name"],
            "role": row["role"],
            "created_at": row["user_created_at"],
            "updated_at": row["user_updated_at"],
        }
        return user, row

    def _check_csrf(self, session):
        if session["kind"] == "web" and not hmac.compare_digest(
            self.headers.get("X-CSRF-Token", ""), session["csrf_token"]
        ):
            raise ApiError(403, "页面令牌失效，请刷新后重试")

    def _api(self, method, path, query, user, session):
        parts = [part for part in path.split("/") if part]
        if session["kind"] == "api_key" and method != "GET":
            raise ApiError(403, "API Key 只允许读取数据")
        if path == "/api/me" and method == "GET":
            return self._json(200, {"user": user, "auth_kind": session["kind"], "csrf_token": session["csrf_token"]})
        if path == "/api/logout" and method == "POST":
            with WRITE_LOCK, db_connection() as db:
                db.execute("DELETE FROM sessions WHERE id = ?", (session["id"],))
                audit(db, user["id"], "session.logout", "session", session["id"])
            return self._json(200, {"status": "ok"}, {"Set-Cookie": "dh_session=; Path=/; Max-Age=0"})
        if user["role"] == "pending":
            raise ApiError(403, "账号正在等待管理员审核")

        if parts[:2] == ["api", "api-keys"] and session["kind"] != "web":
            raise ApiError(403, "请在本人登录的网页中管理 Key")
        if path == "/api/api-keys":
            if method == "GET":
                return self._list_api_keys(user)
            if method == "POST":
                return self._create_api_key(user)
        if len(parts) == 3 and parts[:2] == ["api", "api-keys"] and method == "DELETE":
            return self._revoke_api_key(user, parts[2])
        if len(parts) == 3 and parts[:2] == ["api", "api-keys"] and method == "PATCH":
            return self._update_api_key(user, parts[2])

        if path == "/api/users" and method == "GET":
            return self._list_users(user)
        if len(parts) == 3 and parts[:2] == ["api", "users"] and method == "PATCH":
            return self._update_user(user, parts[2])

        if path == "/api/projects" and method == "GET":
            return self._list_projects(user)
        if path == "/api/projects" and method == "POST":
            return self._create_project(user)
        if len(parts) >= 3 and parts[:2] == ["api", "projects"]:
            project_id = parts[2]
            if len(parts) == 3 and method == "GET":
                return self._project_detail(user, project_id)
            if len(parts) == 3 and method == "DELETE":
                return self._delete_project(user, project_id)
            if len(parts) == 4 and parts[3] == "restore" and method == "POST":
                return self._restore_project(user, project_id)
            if len(parts) == 4 and parts[3] == "purge" and method == "DELETE":
                return self._purge_project(user, project_id)
            if len(parts) == 4 and parts[3] == "folders":
                if method == "GET":
                    return self._list_folders(user, project_id)
                if method == "POST":
                    return self._create_folder(user, project_id)
            if len(parts) == 4 and parts[3] == "members":
                if method == "GET":
                    return self._list_members(user, project_id)
                if method == "POST":
                    return self._add_member(user, project_id)
            if len(parts) == 5 and parts[3] == "members":
                if method == "PATCH":
                    return self._update_member(user, project_id, parts[4])
                if method == "DELETE":
                    return self._remove_member(user, project_id, parts[4])
            if len(parts) == 4 and parts[3] == "artboards" and method == "GET":
                return self._list_artboards(user, project_id, query)
            if len(parts) == 5 and parts[3:] == ["artboards", "upload"] and method == "POST":
                return self._upload_artboards(user, project_id)
            if len(parts) == 4 and parts[3] == "uploads" and method == "POST":
                return self._staged_upload(user, project_id)
            if len(parts) == 6 and parts[3] == "uploads" and method == "POST":
                return self._staged_upload(user, project_id, parts[4], parts[5])

        if len(parts) == 3 and parts[:2] == ["api", "artboards"]:
            if method == "GET":
                return self._artboard_detail(user, parts[2])
            if method == "DELETE":
                return self._delete_artboard(user, parts[2])
        if len(parts) == 4 and parts[:2] == ["api", "artboards"] and parts[3] == "ai-context" and method == "GET":
            return self._artboard_ai_context(user, parts[2], query)
        if len(parts) == 4 and parts[:2] == ["api", "artboards"] and parts[3] == "restore" and method == "POST":
            return self._restore_artboard(user, parts[2])
        if len(parts) == 4 and parts[:2] == ["api", "artboards"] and parts[3] == "purge" and method == "DELETE":
            return self._purge_artboard(user, parts[2])
        if len(parts) == 3 and parts[:2] == ["api", "versions"] and method == "GET":
            return self._version_detail(user, parts[2])
        if len(parts) == 4 and parts[:2] == ["api", "versions"] and parts[3] == "preview" and method == "GET":
            return self._download_preview(user, parts[2])
        if len(parts) == 4 and parts[:2] == ["api", "versions"] and parts[3] == "export" and method == "GET":
            return self._export_assets(user, parts[2], query)
        if len(parts) == 4 and parts[:2] == ["api", "assets"] and parts[3] == "download" and method == "GET":
            return self._download_asset(user, parts[2])
        if path == "/api/exports/package" and method == "POST":
            return self._package_exports(user)
        if len(parts) == 3 and parts[:2] == ["api", "exports"] and method == "GET":
            return self._download_export(user, parts[2], query)
        if path == "/api/recycle" and method == "GET":
            return self._recycle(user)
        if path == "/api/audit" and method == "GET":
            if session["kind"] != "web":
                raise ApiError(403, "请在网页中查看操作历史")
            return self._audit_logs(user, query)
        raise ApiError(404, "接口不存在")

    def _list_users(self, user):
        if user["role"] != "admin":
            raise ApiError(403, "只有管理员可以查看人员列表")
        with db_connection() as db:
            rows = db.execute("SELECT * FROM users ORDER BY created_at DESC").fetchall()
        return self._json(200, {"users": [public_user(row) for row in rows]})

    def _update_user(self, actor, user_id):
        if actor["role"] != "admin":
            raise ApiError(403, "只有管理员可以管理用户")
        data = self._read_json()
        role = data.get("role")
        new_password = data.get("password")
        if role is not None and role not in SYSTEM_ROLES:
            raise ApiError(400, "系统身份无效")
        if role == "pending":
            raise ApiError(400, "不能把已审核用户重新设为待审核")
        if user_id == actor["id"] and role == "disabled":
            raise ApiError(400, "管理员不能禁用自己")
        with WRITE_LOCK, db_connection() as db:
            target = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
            if not target:
                raise ApiError(404, "用户不存在")
            if role in {"developer", "disabled"}:
                owned = db.execute(
                    "SELECT COUNT(*) FROM project_members WHERE user_id = ? AND role = 'owner'",
                    (user_id,),
                ).fetchone()[0]
                if owned:
                    raise ApiError(409, "该用户仍是项目 Owner，请先转让项目")
            if target["role"] == "admin" and role is not None and role != "admin":
                admin_count = db.execute(
                    "SELECT COUNT(*) FROM users WHERE role = 'admin'"
                ).fetchone()[0]
                if admin_count <= 1:
                    raise ApiError(409, "系统至少需要一名 Admin")
            updates = []
            values = []
            if role is not None:
                updates.append("role = ?")
                values.append(role)
            if new_password:
                updates.append("password_hash = ?")
                values.append(hash_password(validate_password(new_password)))
            if not updates:
                raise ApiError(400, "没有需要更新的内容")
            updates.append("updated_at = ?")
            values.append(utc_now())
            values.append(user_id)
            db.execute(f"UPDATE users SET {', '.join(updates)} WHERE id = ?", values)
            if role == "disabled" or new_password:
                db.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            audit(db, actor["id"], "user.update", "user", user_id, {"role": role, "password_reset": bool(new_password)})
            result = db.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return self._json(200, {"user": public_user(result)})

    def _list_api_keys(self, user):
        with WRITE_LOCK, db_connection() as db:
            rows = db.execute(
                """SELECT id, name, purpose, token_prefix, encrypted_token, created_at, revoked_at
                   FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC""",
                (user["id"],),
            ).fetchall()
            keys = []
            for row in rows:
                item = dict(row)
                encrypted = item.pop("encrypted_token")
                item["token"] = None
                item["recoverable"] = bool(encrypted) and not item["revoked_at"]
                if item["recoverable"]:
                    try:
                        decoded = json.loads(key_cipher(db).decrypt(encrypted.encode()).decode())
                        if decoded["user_id"] != user["id"]:
                            raise InvalidToken()
                        item["token"] = decoded["token"]
                    except (InvalidToken, ValueError, KeyError):
                        raise ApiError(503, "Key 无法解密，请管理员检查加密密钥备份")
                keys.append(item)
        return self._json(200, {"api_keys": keys})

    def _create_api_key(self, user):
        data = self._read_json()
        name = str(data.get("name") or "AI 只读访问").strip()
        purpose = str(data.get("purpose") or "").strip()
        if len(purpose) > 300:
            raise ApiError(400, "用途说明最多300字")
        if not 1 <= len(name) <= 80:
            raise ApiError(400, "API Key 名称长度必须为 1–80 个字符")
        token = "dhk_" + secrets.token_urlsafe(32)
        key_id = uuid4()
        now = utc_now()
        with WRITE_LOCK, db_connection() as db:
            active = db.execute(
                "SELECT COUNT(*) FROM api_keys WHERE user_id = ? AND revoked_at IS NULL",
                (user["id"],),
            ).fetchone()[0]
            if active >= 10:
                raise ApiError(409, "每个用户最多保留 10 个有效 API Key")
            encrypted = key_cipher(db).encrypt(canonical_json({"user_id": user["id"], "token": token}).encode()).decode()
            db.execute(
                """INSERT INTO api_keys (id, user_id, name, purpose, token_hash, token_prefix, encrypted_token, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (key_id, user["id"], name, purpose, hash_token(token), token[:12], encrypted, now),
            )
            audit(db, user["id"], "api_key.create", "api_key", key_id, {"name": name, "prefix": token[:12]})
        return self._json(201, {"api_key": {"id": key_id, "name": name, "prefix": token[:12], "token": token, "scope": "read", "created_at": now}})

    def _update_api_key(self, user, key_id):
        data = self._read_json()
        name = str(data.get("name") or "").strip()
        purpose = str(data.get("purpose") or "").strip()
        if not 1 <= len(name) <= 80 or len(purpose) > 300:
            raise ApiError(400, "别名需1–80字，用途说明最多300字")
        with WRITE_LOCK, db_connection() as db:
            row = db.execute("SELECT name,purpose FROM api_keys WHERE id=? AND user_id=?", (key_id,user["id"])).fetchone()
            if not row:
                raise ApiError(404, "API Key 不存在")
            db.execute("UPDATE api_keys SET name=?,purpose=? WHERE id=?", (name,purpose,key_id))
            audit(db,user["id"],"api_key.update","api_key",key_id,{"name_changed": row["name"] != name,"purpose_changed": row["purpose"] != purpose})
        return self._json(200,{"status":"updated"})

    def _revoke_api_key(self, user, key_id):
        with WRITE_LOCK, db_connection() as db:
            row = db.execute(
                "SELECT * FROM api_keys WHERE id = ? AND user_id = ?",
                (key_id, user["id"]),
            ).fetchone()
            if not row:
                raise ApiError(404, "API Key 不存在")
            if not row["revoked_at"]:
                db.execute("UPDATE api_keys SET revoked_at = ?, encrypted_token = NULL WHERE id = ?", (utc_now(), key_id))
                audit(db, user["id"], "api_key.revoke", "api_key", key_id, {"prefix": row["token_prefix"]})
        return self._json(200, {"status": "revoked"})

    def _list_projects(self, user):
        with db_connection() as db:
            if user["role"] == "admin":
                rows = db.execute(
                    """SELECT projects.*, 'admin' AS access_role
                       FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC"""
                ).fetchall()
            else:
                rows = db.execute(
                    """SELECT projects.*, project_members.role AS access_role
                       FROM projects JOIN project_members ON project_members.project_id = projects.id
                       WHERE project_members.user_id = ? AND projects.deleted_at IS NULL
                       ORDER BY projects.updated_at DESC""",
                    (user["id"],),
                ).fetchall()
        return self._json(200, {"projects": [dict(row) for row in rows]})

    def _create_project(self, user):
        if user["role"] not in {"designer", "admin"}:
            raise ApiError(403, "只有设计人员和管理员可以创建项目")
        data = self._read_json()
        name = str(data.get("name", "")).strip()
        description = str(data.get("description", "")).strip()
        if not 1 <= len(name) <= 80:
            raise ApiError(400, "项目名称长度必须为 1–80 个字符")
        now = utc_now()
        project_id = uuid4()
        with WRITE_LOCK, db_connection() as db:
            db.execute(
                """INSERT INTO projects (id, name, description, created_by, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (project_id, name, description, user["id"], now, now),
            )
            if user["role"] != "admin":
                db.execute(
                    """INSERT INTO project_members (project_id, user_id, role, created_at, updated_at)
                       VALUES (?, ?, 'owner', ?, ?)""",
                    (project_id, user["id"], now, now),
                )
            audit(db, user["id"], "project.create", "project", project_id, {"name": name})
        return self._json(201, {"id": project_id})

    def _project_detail(self, user, project_id):
        with db_connection() as db:
            role = require_project_role(db, user, project_id, {"viewer", "editor", "owner", "admin"})
            project = db.execute("SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL", (project_id,)).fetchone()
            if not project:
                raise ApiError(404, "项目不存在")
        payload = dict(project)
        payload["access_role"] = role
        return self._json(200, {"project": payload})

    def _delete_project(self, user, project_id):
        with WRITE_LOCK, db_connection() as db:
            require_project_role(db, user, project_id, {"owner", "admin"})
            db.execute("UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ?", (utc_now(), utc_now(), project_id))
            audit(db, user["id"], "project.delete", "project", project_id)
        return self._json(200, {"status": "recycled"})

    def _restore_project(self, user, project_id):
        with WRITE_LOCK, db_connection() as db:
            require_project_role(db, user, project_id, {"owner", "admin"}, include_deleted=True)
            db.execute("UPDATE projects SET deleted_at = NULL, updated_at = ? WHERE id = ?", (utc_now(), project_id))
            audit(db, user["id"], "project.restore", "project", project_id)
        return self._json(200, {"status": "restored"})

    def _purge_project(self, user, project_id):
        if user["role"] != "admin":
            raise ApiError(403, "只有管理员可以永久删除项目")
        target = PROJECT_DATA_DIR / project_id
        with WRITE_LOCK, db_connection() as db:
            project = db.execute("SELECT id FROM projects WHERE id = ? AND deleted_at IS NOT NULL", (project_id,)).fetchone()
            if not project:
                raise ApiError(404, "回收站中没有该项目")
            audit(db, user["id"], "project.purge", "project", project_id)
            db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        if target.is_dir() and target.parent == PROJECT_DATA_DIR:
            shutil.rmtree(target)
        return self._json(200, {"status": "purged"})

    def _list_folders(self, user, project_id):
        with db_connection() as db:
            require_project_role(db, user, project_id, {"viewer", "editor", "owner", "admin"})
            rows = db.execute(
                "SELECT * FROM folders WHERE project_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC",
                (project_id,),
            ).fetchall()
        return self._json(200, {"folders": [dict(row) for row in rows]})

    def _create_folder(self, user, project_id):
        data = self._read_json()
        name = str(data.get("name", "")).strip()
        if not 1 <= len(name) <= 80:
            raise ApiError(400, "目录名称长度必须为 1–80 个字符")
        with WRITE_LOCK, db_connection() as db:
            require_project_role(db, user, project_id, {"editor", "owner", "admin"})
            folder_id = uuid4()
            now = utc_now()
            try:
                db.execute(
                    """INSERT INTO folders (id, project_id, name, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?)""",
                    (folder_id, project_id, name, now, now),
                )
            except sqlite3.IntegrityError:
                raise ApiError(409, "项目中已存在同名目录")
            audit(db, user["id"], "folder.create", "folder", folder_id, {"project_id": project_id, "name": name})
        return self._json(201, {"id": folder_id})

    def _list_members(self, user, project_id):
        with db_connection() as db:
            require_project_role(db, user, project_id, {"owner", "admin"})
            members = db.execute(
                """SELECT users.id, users.username, users.display_name, users.role AS system_role,
                          project_members.role AS project_role, project_members.created_at
                   FROM project_members JOIN users ON users.id = project_members.user_id
                   WHERE project_members.project_id = ? ORDER BY project_members.role DESC, users.display_name""",
                (project_id,),
            ).fetchall()
            candidates = db.execute(
                """SELECT id, username, display_name, role FROM users
                   WHERE role IN ('developer','designer') ORDER BY display_name"""
            ).fetchall()
        return self._json(200, {"members": [dict(row) for row in members], "candidates": [dict(row) for row in candidates]})

    def _add_member(self, user, project_id):
        data = self._read_json()
        target_id = str(data.get("user_id", ""))
        role = str(data.get("role", "viewer"))
        if role not in PROJECT_ROLES:
            raise ApiError(400, "项目角色无效")
        with WRITE_LOCK, db_connection() as db:
            require_project_role(db, user, project_id, {"owner", "admin"})
            target = db.execute("SELECT * FROM users WHERE id = ?", (target_id,)).fetchone()
            if not target or target["role"] not in {"developer", "designer"}:
                raise ApiError(400, "只能添加已审核且启用的用户")
            if target["role"] == "developer" and role != "viewer":
                raise ApiError(400, "开发人员只能被授权为 Viewer")
            current = db.execute("SELECT role FROM project_members WHERE project_id=? AND user_id=?", (project_id,target_id)).fetchone()
            if current and current["role"] == "owner" and role != "owner":
                owners = db.execute("SELECT COUNT(*) FROM project_members WHERE project_id=? AND role='owner'", (project_id,)).fetchone()[0]
                if owners <= 1:
                    raise ApiError(409, "项目至少需要一名 Owner")
            now = utc_now()
            db.execute(
                """INSERT INTO project_members (project_id, user_id, role, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at""",
                (project_id, target_id, role, now, now),
            )
            audit(db, user["id"], "member.upsert", "project_member", f"{project_id}:{target_id}", {"role": role})
        return self._json(200, {"status": "ok"})

    def _update_member(self, user, project_id, target_id):
        return self._add_or_remove_member(user, project_id, target_id, False)

    def _remove_member(self, user, project_id, target_id):
        return self._add_or_remove_member(user, project_id, target_id, True)

    def _add_or_remove_member(self, user, project_id, target_id, removing):
        data = self._read_json() if not removing else {}
        with WRITE_LOCK, db_connection() as db:
            require_project_role(db, user, project_id, {"owner", "admin"})
            current = db.execute(
                "SELECT role FROM project_members WHERE project_id = ? AND user_id = ?",
                (project_id, target_id),
            ).fetchone()
            if not current:
                raise ApiError(404, "项目成员不存在")
            role = None if removing else str(data.get("role", ""))
            if not removing and role not in PROJECT_ROLES:
                raise ApiError(400, "项目角色无效")
            target = db.execute("SELECT role FROM users WHERE id = ?", (target_id,)).fetchone()
            if not removing and target["role"] == "developer" and role != "viewer":
                raise ApiError(400, "开发人员只能被授权为 Viewer")
            if current["role"] == "owner" and (removing or role != "owner"):
                owners = db.execute(
                    "SELECT COUNT(*) FROM project_members WHERE project_id = ? AND role = 'owner'",
                    (project_id,),
                ).fetchone()[0]
                if owners <= 1:
                    raise ApiError(409, "项目至少需要一名 Owner")
            if removing:
                db.execute("DELETE FROM project_members WHERE project_id = ? AND user_id = ?", (project_id, target_id))
                action = "member.remove"
            else:
                db.execute(
                    "UPDATE project_members SET role = ?, updated_at = ? WHERE project_id = ? AND user_id = ?",
                    (role, utc_now(), project_id, target_id),
                )
                action = "member.update"
            audit(db, user["id"], action, "project_member", f"{project_id}:{target_id}", {"role": role})
        return self._json(200, {"status": "ok"})

    def _list_artboards(self, user, project_id, query):
        folder_id = (query.get("folder_id") or [None])[0]
        include_deleted = (query.get("deleted") or ["0"])[0] == "1"
        with db_connection() as db:
            require_project_role(db, user, project_id, {"viewer", "editor", "owner", "admin"})
            sql = """SELECT artboards.*, artboard_versions.version_no,
                            artboard_versions.created_at AS version_created_at
                     FROM artboards
                     LEFT JOIN artboard_versions ON artboard_versions.id = artboards.current_version_id
                     WHERE artboards.project_id = ?"""
            values = [project_id]
            if folder_id:
                sql += " AND artboards.folder_id = ?"
                values.append(folder_id)
            sql += " AND artboards.deleted_at IS {} ORDER BY artboards.updated_at DESC".format("NOT NULL" if include_deleted else "NULL")
            rows = db.execute(sql, values).fetchall()
        return self._json(200, {"artboards": [dict(row) for row in rows]})

    def _upload_artboards(self, user, project_id):
        data = self._read_json()
        folder_id = str(data.get("folder_id", ""))
        boards = data.get("artboards")
        if not isinstance(boards, list) or not boards:
            raise ApiError(400, "至少需要上传一个画板")
        if len(boards) > 100:
            raise ApiError(400, "单次最多上传 100 个画板")
        with WRITE_LOCK, db_connection() as db:
            require_project_role(db, user, project_id, {"editor", "owner", "admin"})
            folder = db.execute(
                "SELECT * FROM folders WHERE id = ? AND project_id = ? AND deleted_at IS NULL",
                (folder_id, project_id),
            ).fetchone()
            if not folder:
                raise ApiError(400, "目标目录不存在")
            results = []
            for board in boards:
                results.append(self._store_artboard(db, user, project_id, folder_id, board))
            now = utc_now()
            db.execute("UPDATE folders SET updated_at = ? WHERE id = ?", (now, folder_id))
            db.execute("UPDATE projects SET updated_at = ? WHERE id = ?", (now, project_id))
        return self._json(200, {"results": results})

    def _staged_upload(self, user, project_id, upload_id=None, action=None):
        data = self._read_json()
        with WRITE_LOCK, db_connection() as db:
            require_project_role(db, user, project_id, {"editor", "owner", "admin"})
            UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
            # 只清理本协议生成、超过一天的暂存目录，不触及正式版本。
            for stale in UPLOAD_DIR.iterdir():
                if re.fullmatch(r"[0-9a-f-]{36}", stale.name) and stale.is_dir() and time.time() - stale.stat().st_mtime > 86400:
                    shutil.rmtree(stale)
            if upload_id is None:
                board = data.get("board")
                folder_id = str(data.get("folder_id", ""))
                if not isinstance(board, dict) or not board.get("sketch_id") or not board.get("name") or not isinstance(board.get("metadata"), dict) or not decode_file(board.get("preview_base64"), "预览"):
                    raise ApiError(400, "缺少画板信息或预览")
                if not db.execute("SELECT id FROM folders WHERE id=? AND project_id=? AND deleted_at IS NULL", (folder_id, project_id)).fetchone():
                    raise ApiError(400, "目标目录不存在")
                upload_id = uuid4()
                target = UPLOAD_DIR / upload_id
                target.mkdir()
                board.pop("assets", None)
                (target / "session.json").write_text(canonical_json({"user_id": user["id"], "project_id": project_id, "folder_id": folder_id, "board": board}), encoding="utf-8")
                return self._json(201, {"upload_id": upload_id})
            if not re.fullmatch(r"[0-9a-f-]{36}", upload_id):
                raise ApiError(400, "上传任务 ID 无效")
            target = UPLOAD_DIR / upload_id
            if not (target / "session.json").is_file():
                raise ApiError(404, "上传任务不存在或已过期")
            session = json.loads((target / "session.json").read_text(encoding="utf-8"))
            if session["user_id"] != user["id"] or session["project_id"] != project_id:
                raise ApiError(403, "无权操作此上传任务")
            if action == "cancel":
                shutil.rmtree(target)
                return self._json(200, {"cancelled": True})
            chunks = sorted(target.glob("chunk-*.json"))
            if action == "chunk":
                assets = data.get("assets")
                if type(data.get("index")) is not int or data["index"] != len(chunks) or not isinstance(assets, list) or not 1 <= len(assets) <= 32:
                    raise ApiError(400, "资源批次序号或数量无效")
                if len(chunks) >= 20000 or sum(p.stat().st_size for p in target.iterdir()) + len(canonical_json(data).encode("utf-8")) > 2 * 1024**3:
                    raise ApiError(413, "单画板暂存超过安全容量")
                for asset in assets:
                    if not isinstance(asset, dict) or not decode_file(asset.get("data_base64"), "资源"):
                        raise ApiError(400, "资源为空或无效")
                temporary = target / "chunk.tmp"
                temporary.write_text(canonical_json(assets), encoding="utf-8")
                os.replace(temporary, target / f"chunk-{len(chunks):06d}.json")
                return self._json(200, {"index": data["index"], "received": len(assets)})
            if action != "commit":
                raise ApiError(404, "上传操作不存在")
            if type(data.get("chunks")) is not int or data["chunks"] != len(chunks) or type(data.get("assets")) is not int:
                raise ApiError(400, "上传批次不完整")
            count = sum(len(json.loads(p.read_text(encoding="utf-8"))) for p in chunks)
            if count != data["assets"]:
                raise ApiError(400, "上传资源不完整")
            if not db.execute("SELECT id FROM folders WHERE id=? AND project_id=? AND deleted_at IS NULL", (session["folder_id"], project_id)).fetchone():
                raise ApiError(400, "目标目录不存在")
            def asset_source():
                # 每次只解码一批；内容哈希与落盘各遍历一次，避免整画板常驻内存。
                for path in chunks:
                    for asset in json.loads(path.read_text(encoding="utf-8")):
                        yield asset, decode_file(asset["data_base64"], "资源")
            result = self._store_artboard(db, user, project_id, session["folder_id"], session["board"], asset_source)
            now = utc_now()
            db.execute("UPDATE folders SET updated_at=? WHERE id=?", (now, session["folder_id"]))
            db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now, project_id))
            # 事务成功才清理暂存，缺批或发布失败不会改变当前版本。
            db.commit()
            shutil.rmtree(target)
        return self._json(200, {"results": [result]})

    def _store_artboard(self, db, user, project_id, folder_id, board, asset_source=None):
        sketch_id = str(board.get("sketch_id", "")).strip()
        name = str(board.get("name", "")).strip()
        metadata = board.get("metadata")
        assets = board.get("assets") or []
        if not sketch_id or not name or not isinstance(metadata, dict) or not isinstance(assets, list):
            raise ApiError(400, "画板缺少 sketch_id、name、metadata 或 assets")
        if len(name) > 160 or len(assets) > 500:
            raise ApiError(400, "画板名称或资源数量超过限制")
        preview = decode_file(board.get("preview_base64"), "画板预览")
        if not preview:
            raise ApiError(400, f"画板“{name}”缺少预览图")
        asset_payloads = []
        digest = hashlib.sha256(canonical_json(metadata).encode("utf-8"))
        digest.update(preview)
        for asset, raw in (asset_source() if asset_source else ((a, decode_file(a.get("data_base64"), "资源")) for a in assets)):
            if not raw:
                continue
            digest.update(raw)
            digest.update(canonical_json({key: asset.get(key) for key in ("layer_id", "name", "kind", "format", "scale", "width", "height")}).encode("utf-8"))
            if asset_source is None:
                asset_payloads.append((asset, raw))
        content_hash = digest.hexdigest()
        existing = db.execute(
            "SELECT * FROM artboards WHERE project_id = ? AND sketch_id = ?",
            (project_id, sketch_id),
        ).fetchone()
        if existing and existing["current_version_id"]:
            current = db.execute("SELECT content_hash FROM artboard_versions WHERE id = ?", (existing["current_version_id"],)).fetchone()
            if current and hmac.compare_digest(current["content_hash"], content_hash):
                db.execute(
                    """UPDATE artboards SET folder_id = ?, name = ?, width = ?, height = ?,
                              canvas_x = ?, canvas_y = ?, deleted_at = NULL, updated_at = ? WHERE id = ?""",
                    (folder_id, name, float(board.get("width") or 0), float(board.get("height") or 0), float(board.get("canvas_x") or 0), float(board.get("canvas_y") or 0), utc_now(), existing["id"]),
                )
                return {"sketch_id": sketch_id, "name": name, "status": "unchanged", "artboard_id": existing["id"]}

        artboard_id = existing["id"] if existing else uuid4()
        version_id = uuid4()
        version_no = (
            db.execute("SELECT COALESCE(MAX(version_no), 0) + 1 FROM artboard_versions WHERE artboard_id = ?", (artboard_id,)).fetchone()[0]
            if existing
            else 1
        )
        final_dir = PROJECT_DATA_DIR / project_id / folder_id / artboard_id / "versions" / version_id
        final_dir.parent.mkdir(parents=True, exist_ok=True)
        temp_dir = Path(tempfile.mkdtemp(prefix=f".{version_id}-", dir=final_dir.parent))
        try:
            metadata_path = temp_dir / "metadata.json"
            preview_path = temp_dir / "preview.png"
            assets_dir = temp_dir / "assets"
            assets_dir.mkdir()
            metadata_path.write_text(canonical_json(metadata), encoding="utf-8")
            preview_path.write_bytes(preview)
            stored_assets = []
            for index, (asset, raw) in enumerate(asset_source() if asset_source else asset_payloads):
                asset_id = uuid4()
                file_format = safe_format(asset.get("format"))
                filename = f"{index:04d}-{asset_id}.{file_format}"
                target = assets_dir / filename
                target.write_bytes(raw)
                stored_assets.append((asset_id, asset, target))
            os.replace(temp_dir, final_dir)
        except Exception:
            shutil.rmtree(temp_dir, ignore_errors=True)
            raise

        now = utc_now()
        if existing:
            db.execute(
                """UPDATE artboards SET folder_id = ?, name = ?, width = ?, height = ?, canvas_x = ?, canvas_y = ?,
                          current_version_id = ?, deleted_at = NULL, updated_at = ? WHERE id = ?""",
                (folder_id, name, float(board.get("width") or 0), float(board.get("height") or 0), float(board.get("canvas_x") or 0), float(board.get("canvas_y") or 0), version_id, now, artboard_id),
            )
            status = "updated"
        else:
            db.execute(
                """INSERT INTO artboards
                   (id, project_id, folder_id, sketch_id, name, width, height, canvas_x, canvas_y, current_version_id, created_at, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (artboard_id, project_id, folder_id, sketch_id, name, float(board.get("width") or 0), float(board.get("height") or 0), float(board.get("canvas_x") or 0), float(board.get("canvas_y") or 0), version_id, now, now),
            )
            status = "created"
        db.execute(
            """INSERT INTO artboard_versions
               (id, artboard_id, version_no, content_hash, metadata_path, preview_path, created_by, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (version_id, artboard_id, version_no, content_hash, str(final_dir / "metadata.json"), str(final_dir / "preview.png"), user["id"], now),
        )
        for asset_id, asset, temporary_target in stored_assets:
            target = final_dir / "assets" / temporary_target.name
            db.execute(
                """INSERT INTO assets
                   (id, version_id, layer_id, name, kind, format, scale, file_path, width, height, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (asset_id, version_id, str(asset.get("layer_id") or ""), str(asset.get("name") or "未命名资源")[:160], str(asset.get("kind") or "slice")[:40], safe_format(asset.get("format")), float(asset.get("scale") or 1), str(target), asset.get("width"), asset.get("height"), now),
            )
        audit(db, user["id"], f"artboard.{status}", "artboard", artboard_id, {"version": version_no, "assets": len(stored_assets)})
        return {"sketch_id": sketch_id, "name": name, "status": status, "artboard_id": artboard_id, "version": version_no}

    def _artboard_detail(self, user, artboard_id):
        with db_connection() as db:
            board = db.execute("SELECT * FROM artboards WHERE id = ? AND deleted_at IS NULL", (artboard_id,)).fetchone()
            if not board:
                raise ApiError(404, "画板不存在")
            role = require_project_role(db, user, board["project_id"], {"viewer", "editor", "owner", "admin"})
            versions = db.execute(
                """SELECT artboard_versions.*, users.display_name AS creator_name
                   FROM artboard_versions JOIN users ON users.id = artboard_versions.created_by
                   WHERE artboard_id = ? ORDER BY version_no DESC""",
                (artboard_id,),
            ).fetchall()
        payload = dict(board)
        payload["access_role"] = role
        return self._json(200, {"artboard": payload, "versions": [dict(row) for row in versions]})

    def _artboard_ai_context(self, user, artboard_id, query):
        requested_version = (query.get("version_id") or [""])[0]
        with db_connection() as db:
            board = db.execute(
                """SELECT artboards.*, projects.name AS project_name, folders.name AS folder_name
                   FROM artboards JOIN projects ON projects.id = artboards.project_id
                   JOIN folders ON folders.id = artboards.folder_id
                   WHERE artboards.id = ? AND artboards.deleted_at IS NULL""",
                (artboard_id,),
            ).fetchone()
            if not board:
                raise ApiError(404, "设计稿不存在")
            role = require_project_role(db, user, board["project_id"], {"viewer", "editor", "owner", "admin"})
            version_id = requested_version or board["current_version_id"]
            version = db.execute(
                "SELECT * FROM artboard_versions WHERE id = ? AND artboard_id = ?",
                (version_id, artboard_id),
            ).fetchone()
            if not version:
                raise ApiError(404, "设计稿版本不存在")
            assets = db.execute(
                "SELECT * FROM assets WHERE version_id = ? ORDER BY name, kind, scale",
                (version_id,),
            ).fetchall()
        metadata = json.loads(Path(version["metadata_path"]).read_text(encoding="utf-8"))
        width = float(board["width"] or 0)
        height = float(board["height"] or 0)
        return self._json(
            200,
            {
                "schema_version": "1.0",
                "generated_at": utc_now(),
                "access": {"user": user["username"], "project_role": role, "scope": "read"},
                "project": {"id": board["project_id"], "name": board["project_name"]},
                "folder": {"id": board["folder_id"], "name": board["folder_name"]},
                "artboard": {"id": board["id"], "name": board["name"], "sketch_id": board["sketch_id"], "width": width, "height": height},
                "version": {"id": version["id"], "number": version["version_no"], "created_at": version["created_at"]},
                "preview_url": f"/api/versions/{version['id']}/preview",
                "layout": ai_layout(metadata, assets, width, height),
            },
        )

    def _version_detail(self, user, version_id):
        with db_connection() as db:
            version = db.execute(
                """SELECT artboard_versions.*, artboards.project_id, artboards.name AS artboard_name
                   FROM artboard_versions JOIN artboards ON artboards.id = artboard_versions.artboard_id
                   WHERE artboard_versions.id = ? AND artboards.deleted_at IS NULL""",
                (version_id,),
            ).fetchone()
            if not version:
                raise ApiError(404, "版本不存在")
            require_project_role(db, user, version["project_id"], {"viewer", "editor", "owner", "admin"})
            assets = db.execute("SELECT * FROM assets WHERE version_id = ? ORDER BY name, scale", (version_id,)).fetchall()
        metadata = json.loads(Path(version["metadata_path"]).read_text(encoding="utf-8"))
        payload = dict(version)
        payload.pop("metadata_path", None)
        payload.pop("preview_path", None)
        payload["preview_url"] = f"/api/versions/{version_id}/preview"
        return self._json(200, {"version": payload, "metadata": metadata, "assets": [{**dict(row), "download_url": f"/api/assets/{row['id']}/download"} for row in assets]})

    def _delete_artboard(self, user, artboard_id):
        with WRITE_LOCK, db_connection() as db:
            board = db.execute("SELECT * FROM artboards WHERE id = ?", (artboard_id,)).fetchone()
            if not board:
                raise ApiError(404, "画板不存在")
            require_project_role(db, user, board["project_id"], {"editor", "owner", "admin"})
            db.execute("UPDATE artboards SET deleted_at = ?, updated_at = ? WHERE id = ?", (utc_now(), utc_now(), artboard_id))
            audit(db, user["id"], "artboard.delete", "artboard", artboard_id)
        return self._json(200, {"status": "recycled"})

    def _restore_artboard(self, user, artboard_id):
        with WRITE_LOCK, db_connection() as db:
            board = db.execute("SELECT * FROM artboards WHERE id = ?", (artboard_id,)).fetchone()
            if not board:
                raise ApiError(404, "画板不存在")
            require_project_role(db, user, board["project_id"], {"editor", "owner", "admin"})
            db.execute("UPDATE artboards SET deleted_at = NULL, updated_at = ? WHERE id = ?", (utc_now(), artboard_id))
            audit(db, user["id"], "artboard.restore", "artboard", artboard_id)
        return self._json(200, {"status": "restored"})

    def _purge_artboard(self, user, artboard_id):
        if user["role"] != "admin":
            raise ApiError(403, "只有管理员可以永久删除设计稿")
        with WRITE_LOCK, db_connection() as db:
            board = db.execute("SELECT * FROM artboards WHERE id = ? AND deleted_at IS NOT NULL", (artboard_id,)).fetchone()
            if not board:
                raise ApiError(404, "回收站中没有该设计稿")
            target = PROJECT_DATA_DIR / board["project_id"] / board["folder_id"] / artboard_id
            audit(db, user["id"], "artboard.purge", "artboard", artboard_id)
            db.execute("DELETE FROM artboards WHERE id = ?", (artboard_id,))
        if target.is_dir() and PROJECT_DATA_DIR in target.parents:
            shutil.rmtree(target)
        return self._json(200, {"status": "purged"})

    def _download_preview(self, user, version_id):
        with db_connection() as db:
            row = db.execute(
                """SELECT artboard_versions.preview_path, artboards.project_id, artboards.name
                   FROM artboard_versions JOIN artboards ON artboards.id = artboard_versions.artboard_id
                   WHERE artboard_versions.id = ? AND artboards.deleted_at IS NULL""",
                (version_id,),
            ).fetchone()
            if not row:
                raise ApiError(404, "预览图不存在")
            require_project_role(db, user, row["project_id"], {"viewer", "editor", "owner", "admin"})
        return self._send_file(Path(row["preview_path"]), f"{row['name']}.png")

    def _download_asset(self, user, asset_id):
        with db_connection() as db:
            row = db.execute(
                """SELECT assets.*, artboards.project_id
                   FROM assets
                   JOIN artboard_versions ON artboard_versions.id = assets.version_id
                   JOIN artboards ON artboards.id = artboard_versions.artboard_id
                   WHERE assets.id = ? AND artboards.deleted_at IS NULL""",
                (asset_id,),
            ).fetchone()
            if not row:
                raise ApiError(404, "资源不存在")
            require_project_role(db, user, row["project_id"], {"viewer", "editor", "owner", "admin"})
        suffix = "jpg" if row["format"] == "jpeg" else row["format"]
        return self._send_file(Path(row["file_path"]), f"{row['name']}@{row['scale']:g}x.{suffix}")

    def _export_assets(self, user, version_id, query):
        layer_id = (query.get("layer_id") or [""])[0]
        layer_name = (query.get("name") or ["asset"])[0][:160]
        file_format = (query.get("format") or ["png"])[0].lower()
        platform = (query.get("platform") or ["ios"])[0].lower()
        try:
            scales = sorted({int(value) for value in (query.get("scales") or ["2,3"])[0].split(",")})
        except ValueError:
            raise ApiError(400, "切图倍率无效")
        if file_format not in {"png", "jpg", "svg"} or platform not in {"ios", "android", "flutter"} or not scales or any(scale not in {1, 2, 3} for scale in scales):
            raise ApiError(400, "切图格式、平台或倍率无效")
        with db_connection() as db:
            version = db.execute(
                """SELECT artboard_versions.id, artboards.project_id
                   FROM artboard_versions JOIN artboards ON artboards.id = artboard_versions.artboard_id
                   WHERE artboard_versions.id = ? AND artboards.deleted_at IS NULL""",
                (version_id,),
            ).fetchone()
            if not version:
                raise ApiError(404, "版本不存在")
            require_project_role(db, user, version["project_id"], {"viewer", "editor", "owner", "admin"})
            rows = db.execute("SELECT * FROM assets WHERE version_id = ? AND layer_id = ?", (version_id, layer_id)).fetchall() if layer_id else []
            if not rows:
                rows = db.execute("SELECT * FROM assets WHERE version_id = ? AND name = ?", (version_id, layer_name)).fetchall()
        assets = [dict(row) for row in rows]
        safe_name = "".join(character if character not in '\\/:*?\"<>|' else "-" for character in layer_name) or "asset"
        files = []
        for scale in scales:
            source_format = "png" if file_format == "jpg" else file_format
            source = next((asset for asset in assets if asset["format"] == source_format and float(asset["scale"]) == scale), None)
            if not source:
                raise ApiError(404, f"{file_format.upper()} {scale}x 尚未上传，请从 Sketch 重新同步")
            source_path = Path(source["file_path"])
            if not source_path.is_file() or DATA_DIR not in source_path.resolve().parents:
                raise ApiError(404, "切图文件不存在")
            suffix = file_format
            if platform == "android":
                filename = f"{safe_name}-{ {1: 'mdpi', 2: 'xhdpi', 3: 'xxhdpi'}[scale]}.{suffix}"
            elif platform == "flutter":
                filename = f"{scale}.0x-{safe_name}.{suffix}"
            else:
                filename = f"{safe_name}{'' if scale == 1 else f'@{scale}x'}.{suffix}"
            if file_format == "jpg":
                with tempfile.TemporaryDirectory(prefix="design-hub-export-") as directory:
                    target = Path(directory) / filename
                    result = subprocess.run(["/usr/bin/sips", "-s", "format", "jpeg", str(source_path), "--out", str(target)], capture_output=True)
                    if result.returncode or not target.is_file():
                        raise ApiError(500, "JPG 转换失败")
                    body = target.read_bytes()
            else:
                body = source_path.read_bytes()
            files.append((filename, body))
        if len(files) == 1:
            return self._download_bytes(files[0][1], files[0][0])
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for filename, body in files:
                bundle.writestr(filename, body)
        return self._download_bytes(archive.getvalue(), f"{safe_name}-{platform}.zip")

    def _download_bytes(self, body, filename):
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(filename)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename)}")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _package_exports(self, user):
        data = self._read_json()
        with db_connection() as db:
            board = db.execute("SELECT id, project_id FROM artboards WHERE id=? AND deleted_at IS NULL", (str(data.get('artboard_id') or ''),)).fetchone()
            if not board:
                raise ApiError(404, "请从有效设计稿生成打包下载")
            require_project_role(db,user,board['project_id'],{'viewer','editor','owner','admin'})
        files = data.get("files")
        archive_name = str(data.get("name") or "assets.zip")[:160]
        if not isinstance(files, list) or not 1 <= len(files) <= 12:
            raise ApiError(400, "导出文件数量无效")
        decoded = []
        total = 0
        for item in files:
            filename = str(item.get("name") or "asset.png")[:180]
            filename = "".join(character if character not in '\\/:*?\"<>|' else "-" for character in filename)
            body = decode_file(item.get("data_base64"), filename)
            total += len(body)
            if total > 80 * 1024 * 1024:
                raise ApiError(413, "组合切图超过 80MB")
            decoded.append((filename, body))
        EXPORT_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        for stale in EXPORT_CACHE_DIR.glob("*.zip"):
            if stale.is_file() and stale.stat().st_mtime < time.time() - 3600:
                stale.unlink(missing_ok=True)
        token = uuid4()
        target = EXPORT_CACHE_DIR / f"{token}.zip"
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as bundle:
            for filename, body in decoded:
                bundle.writestr(filename, body)
        audit_details = {"files": len(decoded), "bytes": total, "name": archive_name, "project_id":board['project_id'], "artboard_id":board['id']}
        with WRITE_LOCK, db_connection() as db:
            audit(db, user["id"], "asset.package", "export", token, audit_details)
        return self._json(201, {"download_url": f"/api/exports/{token}?filename={quote(archive_name)}", "filename": archive_name})

    def _download_export(self, user, token, query):
        if not token or any(character not in "0123456789abcdef-" for character in token.lower()):
            raise ApiError(404, "导出文件不存在")
        with db_connection() as db:
            logged = db.execute("SELECT actor_id,details_json FROM audit_logs WHERE object_type='export' AND object_id=? AND action='asset.package' ORDER BY id DESC LIMIT 1", (token,)).fetchone()
            if not logged or logged['actor_id'] != user['id']:
                raise ApiError(403,"只能下载本人生成的资源包")
            details = json.loads(logged['details_json'])
            board = db.execute("SELECT project_id FROM artboards WHERE id=? AND deleted_at IS NULL", (details.get('artboard_id'),)).fetchone()
            if not board:
                raise ApiError(404,"设计稿已删除或旧下载已失效，请重新导出")
            require_project_role(db,user,board['project_id'],{'viewer','editor','owner','admin'})
        target = EXPORT_CACHE_DIR / f"{token}.zip"
        if not target.is_file():
            raise ApiError(404, "导出文件已过期")
        filename = (query.get("filename") or ["design-hub-assets.zip"])[0]
        filename = "".join(character if character not in '\\/:*?\"<>|' else "-" for character in filename)[:160]
        return self._send_file(target, filename if filename.endswith(".zip") else f"{filename}.zip")

    def _send_file(self, path, filename):
        if not path.is_file() or DATA_DIR not in path.resolve().parents:
            raise ApiError(404, "文件不存在")
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(filename)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", f"attachment; filename*=UTF-8''{quote(filename)}")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _recycle(self, user):
        with db_connection() as db:
            if user["role"] == "admin":
                projects = db.execute("SELECT * FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").fetchall()
                boards = db.execute("SELECT * FROM artboards WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").fetchall()
            else:
                projects = db.execute(
                    """SELECT projects.* FROM projects JOIN project_members ON project_members.project_id = projects.id
                       WHERE project_members.user_id = ? AND project_members.role = 'owner' AND projects.deleted_at IS NOT NULL""",
                    (user["id"],),
                ).fetchall()
                boards = db.execute(
                    """SELECT artboards.* FROM artboards JOIN project_members ON project_members.project_id = artboards.project_id
                       WHERE project_members.user_id = ? AND project_members.role IN ('editor','owner') AND artboards.deleted_at IS NOT NULL""",
                    (user["id"],),
                ).fetchall()
        return self._json(200, {"projects": [dict(row) for row in projects], "artboards": [dict(row) for row in boards]})

    def _audit_logs(self, user, query):
        try:
            limit = min(max(int((query.get("limit") or [50])[0]), 1), 100)
            before = int((query.get("before") or [0])[0])
        except ValueError:
            raise ApiError(400,"分页参数无效")
        project_id = (query.get('project_id') or [''])[0]
        action = (query.get('action') or [''])[0]
        with db_connection() as db:
            clauses = []; values = []
            if project_id:
                require_project_role(db,user,project_id,{'owner','admin'},include_deleted=True)
                clauses.append('audit_logs.project_id=?'); values.append(project_id)
            elif user['role'] != 'admin':
                clauses.append("audit_logs.project_id IN (SELECT project_id FROM project_members WHERE user_id=? AND role='owner')")
                values.append(user['id'])
            if before:
                clauses.append('audit_logs.id<?'); values.append(before)
            if action:
                clauses.append('audit_logs.action=?'); values.append(action)
            where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
            rows = db.execute(
                """SELECT audit_logs.*, users.display_name AS actor_name
                   FROM audit_logs LEFT JOIN users ON users.id = audit_logs.actor_id
                """ + where + " ORDER BY audit_logs.id DESC LIMIT ?",
                (*values,limit+1),
            ).fetchall()
        return self._json(200, {"logs": [dict(row) for row in rows[:limit]], "next_cursor":rows[limit-1]['id'] if len(rows)>limit else None})


def main():
    init_database()
    ensure_initial_admin()
    server = ThreadingHTTPServer((HOST, PORT), DesignHubHandler)
    print(f"[Server] Design Hub listening on http://{HOST}:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
