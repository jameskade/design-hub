"""从自包含单稿包安全合成目录 Sketch；冲突时失败，不猜测覆盖。"""
import hashlib
import io
import json
import uuid
import zipfile

try:
    from .source_packages import canonical_json
except ImportError:
    from source_packages import canonical_json


def _nodes(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from _nodes(child)


def _layer_nodes(layer):
    yield layer
    for child in layer.get("layers") or []:
        yield from _layer_nodes(child)


def _merge_unique(target, values, identity, label):
    known = {identity(value): canonical_json(value) for value in target}
    for value in values:
        key = identity(value)
        encoded = canonical_json(value)
        if key in known and known[key] != encoded:
            raise ValueError(f"目录 Sketch 存在冲突的{label}")
        if key not in known:
            target.append(value); known[key] = encoded


def _build_collection(groups):
    groups = [(name, packages) for name, packages in groups if packages]
    if not groups:
        raise ValueError("没有可导出的设计稿")
    all_packages = [package for _, packages in groups for package in packages]
    first_document = json.loads(all_packages[0][1]["document.json"])
    document = json.loads(json.dumps(first_document))
    document["pages"] = []
    document["foreignSymbols"] = []
    for key in ("layerStyles", "layerTextStyles"):
        document[key] = {**(document.get(key) or {}), "objects": []}
    for key in ("foreignLayerStyles", "foreignTextStyles"):
        document[key] = []

    # 单稿包已自包含；这里只合并完全一致的依赖，任何同 ID/同路径冲突都停止，避免产出可打开但内容错误的文件。
    symbols, external = [], {}
    meta_source = json.loads(all_packages[0][1]["meta.json"])
    seen_ids = set()
    output_pages, metadata_pages = [], {}
    for page_name, packages in groups:
        artboards = []
        for root_id, files in packages:
            source_document = json.loads(files["document.json"])
            root = None
            package_symbols = []
            for reference in source_document.get("pages", []):
                page = json.loads(files[reference["_ref"] + ".json"])
                for layer in page.get("layers", []):
                    if layer.get("do_objectID") == root_id:
                        root = layer
                    elif layer.get("_class") == "symbolMaster":
                        package_symbols.append(layer)
            if root is None:
                raise ValueError("单稿包缺少目标设计稿")
            for node in _layer_nodes(root):
                object_id = node.get("do_objectID")
                if object_id and object_id in seen_ids:
                    raise ValueError("目录 Sketch 存在重复图层 ID")
                if object_id:
                    seen_ids.add(object_id)
            artboards.append(root)
            _merge_unique(symbols, package_symbols, lambda item: item.get("symbolID"), "Symbol")
            _merge_unique(document["foreignSymbols"], source_document.get("foreignSymbols", []), lambda item: item.get("symbolMaster", {}).get("symbolID"), "外部 Symbol")
            for key in ("layerStyles", "layerTextStyles"):
                _merge_unique(document[key]["objects"], (source_document.get(key) or {}).get("objects", []), lambda item: item.get("do_objectID"), "共享样式")
            for key in ("foreignLayerStyles", "foreignTextStyles"):
                _merge_unique(document[key], source_document.get(key, []), lambda item: item.get("localSharedStyle", {}).get("do_objectID"), "外部样式")
            for path, raw in files.items():
                if not path.startswith(("images/", "fonts/")):
                    continue
                if path in external and external[path] != raw:
                    raise ValueError("目录 Sketch 存在同路径不同内容的图片或字体")
                external[path] = raw

        # 每个目录独立成为 Page；目录内画板统一四列排布，内部坐标保持不变。
        x = y = row_height = 0.0
        for index, artboard in enumerate(artboards):
            frame = artboard.setdefault("frame", {})
            if index and index % 4 == 0:
                x = 0.0; y += row_height + 200.0; row_height = 0.0
            frame["x"], frame["y"] = x, y
            x += float(frame.get("width") or 0) + 200.0
            row_height = max(row_height, float(frame.get("height") or 0))

        page_id = str(uuid.uuid4()).upper()
        page = {"_class": "page", "do_objectID": page_id, "name": page_name, "layers": artboards}
        output_pages.append((f"pages/{page_id}.json", page))
        document["pages"].append({"_class": "MSJSONFileReference", "_ref_class": "MSImmutablePage", "_ref": f"pages/{page_id}"})
        metadata_pages[page_id] = {"name": page_name, "artboards": {item["do_objectID"]: {"name": item.get("name", "")} for item in artboards}}

    if symbols:
        symbol_page_id = str(uuid.uuid4()).upper()
        symbol_page = {"_class": "page", "do_objectID": symbol_page_id, "name": "Symbols", "layers": symbols}
        output_pages.append((f"pages/{symbol_page_id}.json", symbol_page))
        document["pages"].append({"_class": "MSJSONFileReference", "_ref_class": "MSImmutablePage", "_ref": f"pages/{symbol_page_id}"})

    meta = {**meta_source, "pagesAndArtboards": metadata_pages}
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("document.json", canonical_json(document))
        archive.writestr("meta.json", canonical_json(meta))
        archive.writestr("user.json", "{}")
        for path, page in output_pages:
            archive.writestr(path, canonical_json(page))
        for path, raw in sorted(external.items()):
            archive.writestr(path, raw)
    fingerprint = [(page_name, root_id, hashlib.sha256(files["document.json"]).hexdigest()) for page_name, packages in groups for root_id, files in packages]
    return output.getvalue(), hashlib.sha256(canonical_json(fingerprint).encode()).hexdigest()


def build_directory(packages, directory_name):
    return _build_collection([(directory_name, packages)])


def build_project(groups):
    return _build_collection(groups)
