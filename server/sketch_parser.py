"""把单设计稿 Sketch JSON 转为稳定、可版本化的设计上下文。"""
import json


PARSER_VERSION = 1


def _color(value):
    if not isinstance(value, dict):
        return None
    red, green, blue, alpha = (float(value.get(key, 0 if key != "alpha" else 1)) for key in ("red", "green", "blue", "alpha"))
    return {"hex": "#{:02X}{:02X}{:02X}".format(round(red * 255), round(green * 255), round(blue * 255)), "alpha": alpha}


def _style(layer):
    style = layer.get("style") or {}
    def effects(key):
        result = []
        for item in style.get(key) or []:
            result.append({
                "enabled": item.get("isEnabled", True),
                "color": _color(item.get("color")),
                "fill_type": item.get("fillType"),
                "thickness": item.get("thickness"),
                "position": item.get("position"),
                "x": item.get("offsetX"), "y": item.get("offsetY"),
                "blur": item.get("blurRadius"), "spread": item.get("spread"),
            })
        return result
    context = style.get("contextSettings") or {}
    return {
        "opacity": context.get("opacity", 1),
        "fills": effects("fills"), "borders": effects("borders"), "shadows": effects("shadows"),
        "blurs": [{"enabled": item.get("isEnabled", True), "type": item.get("type"), "radius": item.get("radius")} for item in style.get("blurs") or []],
    }


def _text(layer):
    attributed = layer.get("attributedString") or {}
    ranges = attributed.get("attributes") or []
    attributes = ranges[0].get("attributes", {}) if ranges else {}
    font = (attributes.get("MSAttributedStringFontAttribute") or {}).get("attributes") or {}
    paragraph = attributes.get("paragraphStyle") or {}
    runs = []
    for item in ranges:
        values = item.get("attributes") or {}
        run_font = (values.get("MSAttributedStringFontAttribute") or {}).get("attributes") or {}
        runs.append({
            "location": item.get("location"), "length": item.get("length"),
            "font_name": run_font.get("name"), "font_size": run_font.get("size"),
            "color": _color(values.get("MSAttributedStringColorAttribute")), "kerning": values.get("kerning"),
        })
    return {
        "content": attributed.get("string", ""),
        "font_name": font.get("name"), "font_size": font.get("size"),
        "color": _color(attributes.get("MSAttributedStringColorAttribute")),
        "kerning": attributes.get("kerning"), "alignment": paragraph.get("alignment"), "runs": runs,
    }


def parse_design(package, board_id):
    document = json.loads(package["document.json"])
    meta = json.loads(package["meta.json"])
    root = None
    for reference in document.get("pages", []):
        page = json.loads(package[reference["_ref"] + ".json"])
        for layer in page.get("layers", []):
            if layer.get("do_objectID") == board_id:
                root = layer
                break
        if root:
            break
    if not root:
        raise ValueError("单稿源包缺少目标设计稿")
    layers = []

    def visit(layer, parent_id=None, parent_x=0.0, parent_y=0.0, depth=0, parent_visible=True, path=()):
        frame = layer.get("frame") or {}
        layer_id = str(layer.get("do_objectID") or "")
        relative = {key: float(frame.get(key) or 0) for key in ("x", "y", "width", "height")}
        absolute = {**relative, "x": parent_x + relative["x"], "y": parent_y + relative["y"]}
        visible = parent_visible and layer.get("isVisible", True) is not False
        children = layer.get("layers") or []
        item = {
            "id": layer_id, "parent_id": parent_id, "children": [str(child.get("do_objectID") or "") for child in children],
            "depth": depth, "path": [*path, str(layer.get("name") or layer.get("_class") or "未命名")],
            "name": str(layer.get("name") or "未命名"), "type": str(layer.get("_class") or "layer"),
            "visible": visible, "locked": bool(layer.get("isLocked")), "rotation": float(layer.get("rotation") or 0),
            "is_mask": bool(layer.get("hasClippingMask")), "clips_content": bool(layer.get("hasClippingMask") or layer.get("clippingMaskMode")),
            "constraints": {key: layer.get(key) for key in ("resizingConstraint", "horizontalSizing", "verticalSizing", "horizontalPins", "verticalPins")},
            "relative_frame": relative, "absolute_frame": absolute,
            "style": _style(layer), "export_formats": (layer.get("exportOptions") or {}).get("exportFormats") or [],
        }
        item["selectable"] = visible and relative["width"] > 0 and relative["height"] > 0 and item["type"] != "shapePath"
        item["export_boundary"] = bool(item["export_formats"]) or item["type"] in {"bitmap", "image", "shape", "symbolInstance"}
        if layer.get("_class") == "text":
            item["text"] = _text(layer)
        layers.append(item)
        for child in children:
            visit(child, layer_id, absolute["x"], absolute["y"], depth + 1, visible, tuple(item["path"]))

    visit(root)
    frame = root.get("frame") or {}
    return {
        "format_version": 1, "parser_version": PARSER_VERSION,
        "source": {"app": meta.get("app"), "app_version": meta.get("appVersion"), "build": meta.get("build")},
        "design": {"id": board_id, "name": root.get("name", ""), "width": float(frame.get("width") or 0), "height": float(frame.get("height") or 0)},
        "root_layer_id": board_id, "layers": layers,
    }
