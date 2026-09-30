#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR"
OUTPUT_DIR="$SCRIPT_DIR/.global"
BIN_DIR="$HOME/.local/bin"
COMMAND_NAME="gh_design_hub"
FORCE=0
UNINSTALL=0
REINSTALL=0

normalize_name() {
  local value="${1:-design_hub}"
  value="${value#gh_}"
  printf 'gh_%s' "$value"
}

usage() {
  cat <<'EOF'
Usage: ./install_global_design_hub.sh [options]
  --repo-root <path>      Project root
  --output-dir <path>     Generated wrapper directory (default: .global)
  --command-name <name>   Command name, normalized to gh_* (default: gh_design_hub)
  --bin-dir <path>        Global bin directory (default: ~/.local/bin)
  --force                 Replace existing wrapper
  --uninstall             Remove global command
  --reinstall             Reinstall global command
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root) REPO_ROOT="$2"; shift ;;
    --output-dir) OUTPUT_DIR="$2"; shift ;;
    --command-name) COMMAND_NAME="$(normalize_name "$2")"; shift ;;
    --bin-dir) BIN_DIR="$2"; shift ;;
    --force) FORCE=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --reinstall) REINSTALL=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf '[ERR] unknown argument: %s\n' "$1" >&2; usage; exit 1 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$REPO_ROOT" && pwd)"
mkdir -p "$OUTPUT_DIR" "$BIN_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
BIN_DIR="$(cd "$BIN_DIR" && pwd)"
CONTROLLER="$REPO_ROOT/gh_design_hub"
WRAPPER="$OUTPUT_DIR/$COMMAND_NAME"
TARGET="$BIN_DIR/$COMMAND_NAME"

uninstall() {
  [[ -L "$TARGET" || -f "$TARGET" ]] && rm -f "$TARGET"
  [[ -f "$WRAPPER" ]] && rm -f "$WRAPPER"
  printf '[OK] 已卸载 %s\n' "$COMMAND_NAME"
}

if [[ "$UNINSTALL" == "1" || "$REINSTALL" == "1" ]]; then uninstall; fi
[[ "$UNINSTALL" == "1" ]] && exit 0
[[ -x "$CONTROLLER" ]] || { printf '[ERR] controller missing or not executable: %s\n' "$CONTROLLER" >&2; exit 1; }

if [[ -e "$WRAPPER" && "$FORCE" != "1" ]]; then
  printf '[ERR] wrapper exists: %s\n' "$WRAPPER" >&2
  exit 1
fi

python3 - "$WRAPPER" "$REPO_ROOT" "$CONTROLLER" <<'PY'
from pathlib import Path
import shlex, sys
wrapper, root, controller = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
wrapper.write_text(
    "#!/usr/bin/env bash\n"
    "set -euo pipefail\n\n"
    f"export DESIGN_HUB_ROOT={shlex.quote(root)}\n"
    f"exec {shlex.quote(controller)} \"$@\"\n",
    encoding="utf-8",
)
PY
chmod +x "$WRAPPER" "$CONTROLLER"
if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  [[ "$FORCE" == "1" ]] || { printf '[ERR] target exists: %s\n' "$TARGET" >&2; exit 1; }
  rm -f "$TARGET"
fi
ln -s "$WRAPPER" "$TARGET"
"$CONTROLLER" prepare >/dev/null
command -v "$COMMAND_NAME" >/dev/null 2>&1 || { printf '[ERR] %s is not in PATH\n' "$BIN_DIR" >&2; exit 1; }
printf '[OK] installed: %s\n' "$TARGET"
printf '[INFO] run "%s" or "%s status"\n' "$COMMAND_NAME" "$COMMAND_NAME"
