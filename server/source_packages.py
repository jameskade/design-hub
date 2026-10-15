import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import tempfile
import uuid
import zipfile
import zlib


def canonical_json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def split_design(files, board_id):
    """把已校验的选区上传包裁成一张设计稿及其传递依赖。"""
    document = json.loads(files["document.json"])
    meta = json.loads(files["meta.json"])
    pages = [(entry, json.loads(files[entry["_ref"] + ".json"])) for entry in document["pages"]]
    symbols = {}
    for _, page in pages:
        for node in _walk(page.get("layers", [])):
            if node.get("_class") == "symbolMaster" and node.get("symbolID"):
                symbols[node["symbolID"]] = node
    for foreign in document.get("foreignSymbols", []):
        master = foreign.get("symbolMaster")
        if master and master.get("symbolID"):
            symbols[master["symbolID"]] = master

    selected = [layer for _, page in pages for layer in page.get("layers", []) if layer.get("do_objectID") == board_id]
    if len(selected) != 1:
        raise ValueError("源稿快照缺少唯一目标设计稿")
    required_symbols, required_styles = set(), set()

    def dependencies(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key in {"symbolID", "value"} and isinstance(child, str) and child in symbols and child not in required_symbols:
                    required_symbols.add(child)
                    dependencies(symbols[child])
                if key == "sharedStyleID" and isinstance(child, str):
                    required_styles.add(child)
                dependencies(child)
        elif isinstance(value, list):
            for child in value:
                dependencies(child)

    dependencies(selected[0])
    result_document = json.loads(json.dumps(document))
    result_document["pages"] = []
    retained = []
    for entry, page in pages:
        page = json.loads(json.dumps(page))
        page["layers"] = [
            layer for layer in page.get("layers", [])
            if layer.get("do_objectID") == board_id
            or (layer.get("_class") == "symbolMaster" and layer.get("symbolID") in required_symbols)
        ]
        if page["layers"]:
            page.pop("userInfo", None)
            result_document["pages"].append(entry)
            retained.append((entry["_ref"] + ".json", page))
    result_document["foreignSymbols"] = [
        item for item in result_document.get("foreignSymbols", [])
        if item.get("symbolMaster", {}).get("symbolID") in required_symbols
    ]
    for key in ("layerStyles", "layerTextStyles"):
        if isinstance(result_document.get(key), dict):
            result_document[key]["objects"] = [
                style for style in result_document[key].get("objects", [])
                if style.get("do_objectID") in required_styles
            ]
    for key in ("foreignLayerStyles", "foreignTextStyles"):
        result_document[key] = [
            style for style in result_document.get(key, [])
            if style.get("localSharedStyle", {}).get("do_objectID") in required_styles
        ]
    result_document.pop("userInfo", None)

    references = set()
    for value in [result_document, *[page for _, page in retained]]:
        for node in _walk(value):
            ref = node.get("_ref")
            if isinstance(ref, str) and not ref.startswith("pages/"):
                references.add(ref)
    missing = references - files.keys()
    if missing:
        raise ValueError("源稿快照缺少设计稿依赖")

    result_meta = json.loads(json.dumps(meta))
    result_meta["pagesAndArtboards"] = {}
    for page_name, page in retained:
        artboards = {
            layer["do_objectID"]: {"name": layer.get("name", "")}
            for layer in page.get("layers", []) if layer.get("do_objectID") == board_id
        }
        page_id = str(page.get("do_objectID") or Path(page_name).stem)
        result_meta["pagesAndArtboards"][page_id] = {"name": page.get("name", ""), "artboards": artboards}
    package = {
        "document.json": canonical_json(result_document).encode(),
        "meta.json": canonical_json(result_meta).encode(),
        "user.json": b"{}",
    }
    package.update({name: canonical_json(page).encode() for name, page in retained})
    package.update({name: files[name] for name in references})
    return package


class SourcePackages:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _blob_path(self, digest):
        return self.root / digest[:2] / (digest + ".zlib")

    def _store_blob(self, raw):
        digest = hashlib.sha256(raw).hexdigest()
        target = self._blob_path(digest)
        if target.exists():
            if hashlib.sha256(zlib.decompress(target.read_bytes())).hexdigest() != digest:
                raise ValueError("共享源稿资源校验失败")
            return digest, target.stat().st_size
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        handle, name = tempfile.mkstemp(prefix=".blob-", dir=target.parent)
        try:
            with os.fdopen(handle, "wb") as output:
                output.write(zlib.compress(raw, 9))
            os.chmod(name, 0o600)
            try:
                os.link(name, target)
            except FileExistsError:
                pass
        finally:
            Path(name).unlink(missing_ok=True)
        return digest, target.stat().st_size

    def store(self, db, package, board_id, sketch_version, created_by, created_at):
        entries = []
        for logical_path, raw in sorted(package.items()):
            path = PurePosixPath(logical_path)
            if path.is_absolute() or ".." in path.parts or "\\" in logical_path or len(logical_path) > 300:
                raise ValueError("源稿包包含不安全路径")
            digest, stored_size = self._store_blob(raw)
            db.execute(
                "INSERT OR IGNORE INTO source_blobs VALUES (?, ?, ?, ?, ?)",
                (digest, str(self._blob_path(digest)), len(raw), stored_size, created_at),
            )
            entries.append((logical_path, digest))
        package_hash = hashlib.sha256(canonical_json(entries).encode()).hexdigest()
        row = db.execute("SELECT id FROM source_packages WHERE package_hash=?", (package_hash,)).fetchone()
        if row:
            return row[0], package_hash
        package_id = str(uuid.uuid4())
        db.execute(
            "INSERT INTO source_packages VALUES (?, ?, ?, ?, ?, ?)",
            (package_id, package_hash, board_id, sketch_version, created_by, created_at),
        )
        db.executemany(
            "INSERT INTO source_package_entries VALUES (?, ?, ?)",
            ((package_id, path, digest) for path, digest in entries),
        )
        return package_id, package_hash

    def bytes(self, db, package_id):
        rows = db.execute(
            """SELECT entry.logical_path, blob.sha256, blob.file_path
               FROM source_package_entries entry
               JOIN source_blobs blob ON blob.sha256=entry.blob_sha256
               WHERE entry.package_id=? ORDER BY entry.logical_path""",
            (package_id,),
        ).fetchall()
        if not rows:
            raise ValueError("源稿包不存在")
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            for logical_path, digest, file_path in rows:
                raw = zlib.decompress(Path(file_path).read_bytes())
                if hashlib.sha256(raw).hexdigest() != digest:
                    raise ValueError("共享源稿资源校验失败")
                archive.writestr(logical_path, raw)
        return output.getvalue()
