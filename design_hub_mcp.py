#!/usr/bin/env python3
import base64
import json
import re
import sys
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen


SERVER_INFO = {"name": "design-hub", "version": "1.0.2"}
ARTBOARD_RE = re.compile(r"/artboards/([0-9a-fA-F-]+)")
ID_RE = re.compile(r"^[0-9A-Za-z-]+$")


def normalize_connection(base_url, api_key):
    parsed = urlparse(str(base_url).strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("base_url 必须是有效的 HTTP(S) 服务地址")
    key = str(api_key).strip()
    if not key.startswith("dhk_"):
        raise ValueError("api_key 必须是 Design Hub 的 dhk_ Key")
    return f"{parsed.scheme}://{parsed.netloc}", key


def request(base_url, api_key, path, binary=False):
    origin, key = normalize_connection(base_url, api_key)
    req = Request(origin + path, headers={"Authorization": f"Bearer {key}", "Accept": "*/*"})
    try:
        with urlopen(req, timeout=30) as response:
            body = response.read(25 * 1024 * 1024 + 1)
            if len(body) > 25 * 1024 * 1024:
                raise ValueError("Design Hub 响应超过 25MB")
            if binary:
                return body, response.headers.get_content_type()
            return json.loads(body.decode("utf-8"))
    except HTTPError as error:
        detail = error.read(4096).decode("utf-8", errors="replace")
        raise ValueError(f"Design Hub HTTP {error.code}: {detail}") from error
    except (URLError, TimeoutError) as error:
        raise ValueError(f"无法连接 Design Hub: {error.reason if hasattr(error, 'reason') else error}") from error


def artboard_id(value):
    match = ARTBOARD_RE.search(str(value))
    candidate = match.group(1) if match else str(value).strip()
    if not ID_RE.fullmatch(candidate):
        raise ValueError("artboard 必须是设计稿链接或画板 ID")
    return candidate


TOOLS = [
    {
        "name": "design_hub_list_projects",
        "description": "列出当前 Design Hub Key 有权查看的项目。地址和 Key 仅用于本次调用。",
        "inputSchema": {
            "type": "object",
            "properties": {"base_url": {"type": "string"}, "api_key": {"type": "string"}},
            "required": ["base_url", "api_key"],
            "additionalProperties": False,
        },
    },
    {
        "name": "design_hub_get_artboard_context",
        "description": "读取设计稿完整结构化上下文：图层、坐标、文字、样式、约束与可下载资源。artboard 可传网页链接或画板 ID。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "base_url": {"type": "string"},
                "api_key": {"type": "string"},
                "artboard": {"type": "string"},
            },
            "required": ["base_url", "api_key", "artboard"],
            "additionalProperties": False,
        },
    },
    {
        "name": "design_hub_get_asset",
        "description": "读取一个 Design Hub 图片或 SVG 资源，返回 MCP 图片内容。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "base_url": {"type": "string"},
                "api_key": {"type": "string"},
                "asset_id": {"type": "string"},
            },
            "required": ["base_url", "api_key", "asset_id"],
            "additionalProperties": False,
        },
    },
]


def call_tool(name, arguments):
    if name == "design_hub_list_projects":
        payload = request(arguments["base_url"], arguments["api_key"], "/api/projects")
        return [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]
    if name == "design_hub_get_artboard_context":
        board_id = artboard_id(arguments["artboard"])
        payload = request(arguments["base_url"], arguments["api_key"], f"/api/artboards/{quote(board_id)}/ai-context")
        return [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]
    if name == "design_hub_get_asset":
        asset_id = str(arguments["asset_id"]).strip()
        if not ID_RE.fullmatch(asset_id):
            raise ValueError("asset_id 无效")
        body, mime_type = request(arguments["base_url"], arguments["api_key"], f"/api/assets/{quote(asset_id)}/download", binary=True)
        return [{"type": "image", "data": base64.b64encode(body).decode("ascii"), "mimeType": mime_type}]
    raise ValueError(f"未知工具: {name}")


def handle(message):
    method = message.get("method")
    request_id = message.get("id")
    if method == "initialize":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"protocolVersion": "2025-03-26", "capabilities": {"tools": {}}, "serverInfo": SERVER_INFO}}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": request_id, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": request_id, "result": {"tools": TOOLS}}
    if method == "tools/call":
        params = message.get("params") or {}
        try:
            content = call_tool(params.get("name"), params.get("arguments") or {})
            result = {"content": content, "isError": False}
        except (KeyError, TypeError, ValueError) as error:
            result = {"content": [{"type": "text", "text": str(error)}], "isError": True}
        return {"jsonrpc": "2.0", "id": request_id, "result": result}
    if request_id is not None:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "Method not found"}}
    return None


def main():
    for line in sys.stdin:
        try:
            response = handle(json.loads(line))
        except (json.JSONDecodeError, TypeError) as error:
            response = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(error)}}
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
