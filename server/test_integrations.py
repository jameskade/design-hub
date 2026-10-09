"""python3 server/test_integrations.py：临时数据、临时端口；不访问正式服务。"""
import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
from http.cookiejar import CookieJar
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, ProxyHandler, Request, build_opener
import zipfile


def main():
    repo = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="design-hub-integrations-") as temp:
        root = Path(temp).resolve()
        os.environ["DESIGN_HUB_DATA_DIR"] = str(root / "data")
        os.environ["DESIGN_HUB_ADMIN_USERNAME"] = "integration-admin"
        os.environ["DESIGN_HUB_ADMIN_PASSWORD"] = "IntegrationTestOnly2026!"
        spec = importlib.util.spec_from_file_location("design_hub_integration_test", repo / "server/app.py")
        app = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(app)
        source = root / "source"
        shutil.copytree(repo / "sketch-plugin", source / "sketch-plugin")
        shutil.copytree(repo / "server/static", source / "server/static")
        shutil.copyfile(repo / "design_hub_mcp.py", source / "design_hub_mcp.py")
        (source / "sketch-plugin/DesignHub.sketchplugin/.env").write_text("PRIVATE_FIXTURE_NOT_FOR_DOWNLOAD", encoding="utf-8")
        app.ROOT = source
        app.STATIC_DIR = source / "server/static"
        app.init_database()
        app.ensure_initial_admin()

        class Handler(app.DesignHubHandler):
            def log_message(self, *args):
                pass

        server = app.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        origin = f"http://127.0.0.1:{server.server_port}"

        class Client:
            def __init__(self):
                self.opener = build_opener(ProxyHandler({}), HTTPCookieProcessor(CookieJar()))
                self.csrf = ""

            def call(self, route, body=None, expected=200):
                headers = {"Content-Type": "application/json"}
                if self.csrf:
                    headers["X-CSRF-Token"] = self.csrf
                request = Request(origin + route, data=None if body is None else json.dumps(body).encode(), headers=headers)
                try:
                    response = self.opener.open(request, timeout=8)
                except HTTPError as error:
                    response = error
                with response:
                    assert response.status == expected, (route, response.status, expected)
                    return response.read(), response.headers

            def json(self, route, body=None, expected=200):
                return json.loads(self.call(route, body, expected)[0])

        try:
            anonymous = Client()
            manifest = json.loads((source / "sketch-plugin/DesignHub.sketchplugin/Contents/Sketch/manifest.json").read_text())
            info = anonymous.json("/api/integrations")
            assert info["sketch"]["version"] == manifest["version"]
            assert info["mcp"]["transport"] == "stdio"
            for page in ("sketch", "mcp", "guide"):
                html = anonymous.call("/connect/" + page)[0].decode()
                assert 'id="connect-view"' in html and 'src="/connect.js"' in html
            archive, headers = anonymous.call("/downloads/DesignHub.sketchplugin.zip")
            assert "attachment" in headers["Content-Disposition"]
            with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
                expected = {"DesignHub.sketchplugin/" + relative for relative in app.PLUGIN_DOWNLOAD_FILES}
                assert set(bundle.namelist()) == expected
                for name in expected:
                    assert bundle.read(name) == (source / "sketch-plugin" / name).read_bytes()
            script, headers = anonymous.call("/downloads/design_hub_mcp.py")
            assert script == (repo / "design_hub_mcp.py").read_bytes()
            assert headers["X-Content-Type-Options"] == "nosniff"
            for path in (".env", "../.env", "%2e%2e/.env", "data/design-hub.sqlite3", "unknown.zip"):
                anonymous.call("/downloads/" + path, expected=404)
            anonymous.call("/downloads/design_hub_mcp.py", {}, expected=405)
            anonymous.call("/api/api-keys", expected=401)
            anonymous.json("/api/register", {"username":"pending-test", "display_name":"待审核", "password":"PendingTestOnly2026!"}, expected=201)
            pending = Client()
            pending.csrf = pending.json("/api/login", {"username":"pending-test", "password":"PendingTestOnly2026!"})["csrf_token"]
            pending.call("/api/api-keys", expected=403)
            pending.call("/api/api-keys", {"name":"denied"}, expected=403)
            pending.call("/api/integrations")

            admin = Client()
            admin.csrf = admin.json("/api/login", {"username":"integration-admin", "password":"IntegrationTestOnly2026!"})["csrf_token"]
            key = admin.json("/api/api-keys", {"name":"下载脚本验收"}, expected=201)["api_key"]["token"]
            project = admin.json("/api/projects", {"name":"隔离接入验收"}, expected=201)["id"]
            folder = admin.json(f"/api/projects/{project}/folders", {"name":"验收目录"}, expected=201)["id"]
            png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
            layer = "AAAA0000-1111-2222-3333-444455556666"
            upload = {"folder_id":folder,"artboards":[{"sketch_id":"INTEGRATION-BOARD","name":"接入验收画板","width":390,"height":844,"metadata":{"artboard":{"layers":[{"var":layer,"name":"验收图层","type":"Text","frame":{"x":20,"y":20,"width":20,"height":20},"text":{"content":"验收"}}]}},"preview_base64":png,"assets":[{"layer_id":layer,"name":"验收图层","kind":"slice","format":"png","scale":1,"width":1,"height":1,"data_base64":png}]}]}
            board = admin.json(f"/api/projects/{project}/artboards/upload", upload)["results"][0]["artboard_id"]
            version = admin.json(f"/api/artboards/{board}")["artboard"]["current_version_id"]
            asset = admin.json(f"/api/versions/{version}")["assets"][0]["id"]
            staged_base = f"/api/projects/{project}/uploads"
            stage_body = {"folder_id": folder, "board": upload["artboards"][0]}
            sid = admin.json(staged_base, stage_body, expected=201)["upload_id"]
            stage = f"{staged_base}/{sid}"
            pending.call(stage + "/chunk", {"index": 0, "assets": upload["artboards"][0]["assets"]}, expected=403)
            # 即使另一账号有项目写权限，也不能接管他人的暂存任务。
            with app.db_connection() as db:
                db.execute("UPDATE users SET role='admin' WHERE username='pending-test'")
            pending.call(stage + "/cancel", {}, expected=403)
            with app.db_connection() as db:
                db.execute("UPDATE users SET role='pending' WHERE username='pending-test'")
            batch = upload["artboards"][0]["assets"] * 26
            for index in range(20):
                admin.json(stage + "/chunk", {"index": index, "assets": batch})
            admin.call(stage + "/chunk", {"index": 19, "assets": batch}, expected=400)
            admin.call(stage + "/commit", {"chunks": 21, "assets": 520}, expected=400)
            admin.call(stage + "/commit", {"chunks": 20, "assets": 519}, expected=400)
            assert admin.json(f"/api/artboards/{board}")["artboard"]["current_version_id"] == version
            published = admin.json(stage + "/commit", {"chunks": 20, "assets": 520})["results"][0]
            assert published["status"] == "updated"
            new_version = admin.json(f"/api/artboards/{board}")["artboard"]["current_version_id"]
            assert len(admin.json(f"/api/versions/{new_version}")["assets"]) == 520
            assert not (app.UPLOAD_DIR / sid).exists()
            sid = admin.json(staged_base, stage_body, expected=201)["upload_id"]
            stage = f"{staged_base}/{sid}"
            for index in range(20):
                admin.json(stage + "/chunk", {"index": index, "assets": batch})
            assert admin.json(stage + "/commit", {"chunks": 20, "assets": 520})["results"][0]["status"] == "unchanged"
            sid = admin.json(staged_base, stage_body, expected=201)["upload_id"]
            admin.json(f"{staged_base}/{sid}/cancel", {})
            assert not (app.UPLOAD_DIR / sid).exists()
            print("PASS: 520 资源分批发布、缺批/计数错误保留旧版本、拒绝重复批次、权限、取消清理、重复上传 unchanged")
            downloaded = root / "downloaded_mcp.py"
            downloaded.write_bytes(script)
            requests = [
                {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"isolated-check","version":"1"}}},
                {"jsonrpc":"2.0","id":2,"method":"tools/list"},
            ]
            for number, name, extra in ((3,"design_hub_list_projects",{}),(4,"design_hub_get_artboard_context",{"artboard":f"{origin}/projects/{project}/artboards/{board}"}),(5,"design_hub_get_asset",{"asset_id":asset})):
                requests.append({"jsonrpc":"2.0","id":number,"method":"tools/call","params":{"name":name,"arguments":{"base_url":origin,"api_key":key,**extra}}})
            env = {**os.environ, "NO_PROXY":"127.0.0.1,localhost"}
            result = subprocess.run([sys.executable, str(downloaded)], input="\n".join(map(json.dumps, requests)) + "\n", capture_output=True, text=True, timeout=20, env=env)
            assert result.returncode == 0
            responses = [json.loads(line) for line in result.stdout.splitlines()]
            assert len(responses) == 5 and len(responses[1]["result"]["tools"]) == 3
            assert all(not response["result"].get("isError") for response in responses[2:])
            context = json.loads(responses[3]["result"]["content"][0]["text"])
            assert context["layout"]["layers"][0]["id"] == layer
            image = responses[4]["result"]["content"][0]
            assert image["mimeType"] == "image/png" and base64.b64decode(image["data"]) == base64.b64decode(png)
            print("PASS: 公共接入页面、版本真源、ZIP 白名单、脚本字节、下载边界、匿名/待审核权限、下载后的 MCP 三工具实际调用")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=3)


if __name__ == "__main__":
    main()
