#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="$SCRIPT_DIR/sketch-plugin/DesignHub.sketchplugin"
PLUGIN_DIR="$HOME/Library/Application Support/com.bohemiancoding.sketch3/Plugins"
TARGET="$PLUGIN_DIR/DesignHub.sketchplugin"
MANIFEST="$SOURCE/Contents/Sketch/manifest.json"

[[ -d "$SOURCE" ]] || { printf '[ERR] plugin bundle missing: %s\n' "$SOURCE" >&2; exit 1; }
[[ -f "$MANIFEST" ]] || { printf '[ERR] plugin manifest missing: %s\n' "$MANIFEST" >&2; exit 1; }
VERSION="$(/usr/bin/python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$MANIFEST")"
# 正式版本跟随整体发布；同一版本的开发和验收允许重复安装，仍保留旧插件备份。
mkdir -p "$PLUGIN_DIR"
if [[ -e "$TARGET" ]]; then
  BACKUP="$PLUGIN_DIR/DesignHub.sketchplugin.backup-$(date +%Y%m%d_%H%M%S)"
  mv "$TARGET" "$BACKUP"
  printf '[INFO] existing plugin backed up: %s\n' "$BACKUP"
fi
ditto "$SOURCE" "$TARGET"
xattr -r -d com.apple.quarantine "$TARGET" 2>/dev/null || true
printf '[OK] Design Hub Sketch plugin %s installed from repository source. Restart Sketch to load it.\n' "$VERSION"
