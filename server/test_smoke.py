#!/usr/bin/env python3
import base64
import json
import sys
from http.cookiejar import CookieJar
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, Request, build_opener, urlopen


BASE_URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8765"
PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="


class Client:
    def __init__(self):
        self.opener = build_opener(HTTPCookieProcessor(CookieJar()))
        self.csrf = ""

    def request(self, method, path, body=None, expected=200, token=None):
        headers = {"Accept": "application/json"}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if token:
            headers["Authorization"] = f"Bearer {token}"
        elif method != "GET" and self.csrf:
            headers["X-CSRF-Token"] = self.csrf
        request = Request(BASE_URL + path, data=data, headers=headers, method=method)
        try:
            response = self.opener.open(request)
            status = response.status
            payload = json.loads(response.read().decode("utf-8"))
        except HTTPError as error:
            status = error.code
            payload = json.loads(error.read().decode("utf-8"))
        assert status == expected, (method, path, status, payload)
        return payload

    def login(self, username, password, plugin=False):
        path = "/api/plugin/login" if plugin else "/api/login"
        payload = self.request("POST", path, {"username": username, "password": password})
        self.csrf = payload["csrf_token"]
        return payload


def main():
    admin = Client()
    assert admin.request("GET", "/api/health")["status"] == "ok"
    admin.login("admin", "CodexAcceptance!2026")

    anonymous = Client()
    for username, display_name in (("designer", "设计同学"), ("developer", "开发同学"), ("pending", "待审核用户")):
        anonymous.request("POST", "/api/register", {
            "username": username,
            "display_name": display_name,
            "password": "Acceptance!2026",
        }, expected=201)

    users = admin.request("GET", "/api/users")["users"]
    user_ids = {user["username"]: user["id"] for user in users}
    admin.request("PATCH", f"/api/users/{user_ids['designer']}", {"role": "designer"})
    admin.request("PATCH", f"/api/users/{user_ids['developer']}", {"role": "developer"})

    pending = Client()
    pending.login("pending", "Acceptance!2026")
    pending.request("GET", "/api/projects", expected=403)

    designer = Client()
    designer.login("designer", "Acceptance!2026")
    created = designer.request("POST", "/api/projects", {"name": "验收项目", "description": "smoke"}, expected=201)
    project_id = created["id"]
    assert designer.request("GET", f"/api/projects/{project_id}/folders")["folders"] == []
    folder_id = designer.request("POST", f"/api/projects/{project_id}/folders", {"name": "登录注册"}, expected=201)["id"]
    members = designer.request("GET", f"/api/projects/{project_id}/members")
    assert any(member["project_role"] == "owner" for member in members["members"])
    designer.request("POST", f"/api/projects/{project_id}/members", {"user_id": user_ids["developer"], "role": "editor"}, expected=400)
    designer.request("POST", f"/api/projects/{project_id}/members", {"user_id": user_ids["developer"], "role": "viewer"})

    plugin = Client().login("designer", "Acceptance!2026", plugin=True)
    token = plugin["token"]
    upload = {
        "folder_id": folder_id,
        "artboards": [{
            "sketch_id": "ARTBOARD-SMOKE-1",
            "name": "登录页",
            "width": 390,
            "height": 844,
            "canvas_x": 120,
            "canvas_y": 80,
            "metadata": {"artboard": {"id": "ARTBOARD-SMOKE-1", "name": "登录页", "type": "Artboard", "frame": {"x": 0, "y": 0, "width": 390, "height": 844}, "layers": [{"id": "TEXT-1", "name": "欢迎回来", "type": "Text", "frame": {"x": 24, "y": 80, "width": 160, "height": 28}, "text": {"content": "欢迎回来", "fontFamily": "PingFang SC", "fontSize": 24, "fontWeight": 600}}]}},
            "preview_base64": PNG_1X1,
            "assets": [{"layer_id": "ICON-1", "name": "icon_login", "kind": "slice", "format": "png", "scale": 2, "width": 48, "height": 48, "data_base64": PNG_1X1}],
        }],
    }
    result = Client().request("POST", f"/api/projects/{project_id}/artboards/upload", upload, token=token)["results"][0]
    assert result["status"] == "created"
    artboard_id = result["artboard_id"]
    unchanged = Client().request("POST", f"/api/projects/{project_id}/artboards/upload", upload, token=token)["results"][0]
    assert unchanged["status"] == "unchanged"
    upload["artboards"][0]["metadata"]["artboard"]["layers"][0]["text"]["content"] = "欢迎登录"
    updated = Client().request("POST", f"/api/projects/{project_id}/artboards/upload", upload, token=token)["results"][0]
    assert updated["status"] == "updated" and updated["version"] == 2

    developer = Client()
    developer.login("developer", "Acceptance!2026")
    assert any(project["id"] == project_id for project in developer.request("GET", "/api/projects")["projects"])
    developer.request("POST", "/api/projects", {"name": "不允许"}, expected=403)
    detail = developer.request("GET", f"/api/artboards/{artboard_id}")
    assert len(detail["versions"]) == 2
    assert detail["artboard"]["canvas_x"] == 120 and detail["artboard"]["canvas_y"] == 80
    version_id = detail["artboard"]["current_version_id"]
    version = developer.request("GET", f"/api/versions/{version_id}")
    assert version["metadata"]["artboard"]["name"] == "登录页"
    assert len(version["assets"]) == 1
    developer.request("DELETE", f"/api/artboards/{artboard_id}", expected=403)

    designer.request("DELETE", f"/api/artboards/{artboard_id}")
    assert any(board["id"] == artboard_id for board in designer.request("GET", "/api/recycle")["artboards"])
    designer.request("POST", f"/api/artboards/{artboard_id}/restore")
    assert admin.request("GET", "/api/audit")["logs"]
    print("PASS: auth, RBAC, project membership, versioning, assets, recycle, audit")


if __name__ == "__main__":
    main()
