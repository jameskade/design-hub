"""单设计稿拆分、共享 Blob 与标准 Sketch 重建隔离回归。"""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import zipfile
import io


def encoded(value):
    return json.dumps(value, ensure_ascii=False).encode()


def main():
    with tempfile.TemporaryDirectory(prefix="design-hub-sources-") as directory:
        os.environ["DESIGN_HUB_DATA_DIR"] = directory
        os.environ["DESIGN_HUB_ADMIN_USERNAME"] = "admin"
        os.environ["DESIGN_HUB_ADMIN_PASSWORD"] = "TestAdminOnly!2026"
        spec = importlib.util.spec_from_file_location("source_app", Path(__file__).with_name("app.py"))
        app = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(app)
        app.init_database()
        app.ensure_initial_admin()
        from source_packages import SourcePackages, split_design
        from sketch_parser import parse_design

        document = {
            "pages": [{"_ref": "pages/main"}, {"_ref": "pages/symbols"}],
            "foreignSymbols": [],
            "layerStyles": {"objects": []},
            "layerTextStyles": {"objects": []},
        }
        board = lambda key: {
            "_class": "group", "do_objectID": key, "name": key,
            "layers": [{"_class": "symbolInstance", "do_objectID": key + "-I", "symbolID": "SYMBOL-1", "image": {"_ref": "images/shared.png"}}],
        }
        files = {
            "document.json": encoded(document),
            "meta.json": encoded({"appVersion": "2025.3.4", "pagesAndArtboards": {}}),
            "user.json": b"{}",
            "pages/main.json": encoded({"do_objectID": "PAGE", "name": "Main", "layers": [board("BOARD-A"), board("BOARD-B")]}),
            "pages/symbols.json": encoded({"do_objectID": "SYMBOLS", "name": "Symbols", "layers": [{"_class": "symbolMaster", "do_objectID": "MASTER", "symbolID": "SYMBOL-1", "layers": []}]}),
            "images/shared.png": b"shared-image-bytes",
        }
        packages = SourcePackages(Path(directory) / "source-blobs")
        first, second = split_design(files, "BOARD-A"), split_design(files, "BOARD-B")
        context = parse_design(first, "BOARD-A")
        assert context["root_layer_id"] == "BOARD-A"
        assert [layer["id"] for layer in context["layers"]] == ["BOARD-A", "BOARD-A-I"]
        assert context["layers"][1]["parent_id"] == "BOARD-A"
        with app.db_connection() as db:
            user_id = db.execute("SELECT id FROM users WHERE username_norm='admin'").fetchone()[0]
            first_id, first_hash = packages.store(db, first, "BOARD-A", "2025.3.4", user_id, app.utc_now())
            second_id, second_hash = packages.store(db, second, "BOARD-B", "2025.3.4", user_id, app.utc_now())
            assert first_id != second_id and first_hash != second_hash
            entry_count = db.execute("SELECT count(*) FROM source_package_entries").fetchone()[0]
            blob_count = db.execute("SELECT count(*) FROM source_blobs").fetchone()[0]
            assert blob_count < entry_count
            assert db.execute("SELECT count(*) FROM source_blobs WHERE raw_size=?", (len(b"shared-image-bytes"),)).fetchone()[0] == 1
            rebuilt = packages.bytes(db, first_id)
            try:
                packages.store(db, {"../escape": b"bad"}, "BAD", "2025.3.4", user_id, app.utc_now())
                raise AssertionError("不安全源稿路径未拒绝")
            except ValueError:
                pass
        with zipfile.ZipFile(io.BytesIO(rebuilt)) as archive:
            rebuilt_document = json.loads(archive.read("document.json"))
            page = json.loads(archive.read("pages/main.json"))
            assert len(rebuilt_document["pages"]) == 2
            assert [layer["do_objectID"] for layer in page["layers"]] == ["BOARD-A"]
            assert archive.read("images/shared.png") == b"shared-image-bytes"
        print("PASS: 一稿一源、传递依赖、共享 Blob 去重、标准 Sketch 重建、版本化图层解析")


if __name__ == "__main__":
    main()
