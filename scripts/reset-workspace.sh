#!/usr/bin/env bash
# reset-workspace.sh — openclaw workspace reset tool
#
# Usage:
#   ./scripts/reset-workspace.sh --fresh   Agent "lần đầu gặp mặt": xóa state, giữ config/keys/skills
#   ./scripts/reset-workspace.sh --nuke    Xóa tất cả kể cả config — cài lại từ đầu hoàn toàn
#
# Các path có thể override bằng env vars:
#   CLAWDIS_DIR   (default: ~/.clawdis)
#   CLAWD_DIR     (default: agent.workspace trong clawdis.json, fallback ~/clawd)
#   TEMPLATES_DIR (default: script's ../docs/templates)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CLAWDIS_DIR="${CLAWDIS_DIR:-$HOME/.clawdis}"
TEMPLATES_DIR="${TEMPLATES_DIR:-$REPO_ROOT/docs/templates}"

# Đọc agent.workspace từ clawdis.json nếu có, fallback ~/clawd
_detect_clawd_dir() {
  local cfg="$CLAWDIS_DIR/clawdis.json"
  if [ -f "$cfg" ] && command -v python3 &>/dev/null; then
    python3 -c "
import json, sys
try:
    d = json.load(open('$cfg'))
    w = d.get('agent', {}).get('workspace', '')
    if w: print(w)
except: pass
" 2>/dev/null
  fi
}
CLAWD_DIR="${CLAWD_DIR:-$(_detect_clawd_dir)}"
CLAWD_DIR="${CLAWD_DIR:-$HOME/clawd}"

# ─── Helpers ────────────────────────────────────────────────────────────────

RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${CYAN}[info]${NC}  $*"; }
ok()      { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
section() { echo -e "\n${BOLD}$*${NC}"; }

# Dùng trash nếu có, fallback sang backup vào /tmp
safe_remove() {
  local target="$1"
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    return 0
  fi
  if command -v trash &>/dev/null; then
    trash "$target" && info "trashed: $target"
  else
    local backup="/tmp/openclaw-reset-backup-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$backup"
    mv "$target" "$backup/" && info "backed up: $backup/$(basename "$target")"
  fi
}

copy_template() {
  local name="$1"
  local src="$TEMPLATES_DIR/$name"
  local dst="$CLAWD_DIR/$name"
  if [ ! -f "$src" ]; then
    warn "template not found: $src — skipping"
    return 0
  fi
  cp "$src" "$dst"
  ok "copied: $name"
}

# ─── Modes ──────────────────────────────────────────────────────────────────

mode_fresh() {
  section "Mode: --fresh"
  echo -e "Agent sẽ được reset về trạng thái ${BOLD}lần đầu gặp mặt${NC}."
  echo
  echo "Xóa:"
  echo "  - Chat sessions và history"
  echo "  - Agent memory (memory.md, memory/, memory.sqlite)"
  echo "  - Agent identity (IDENTITY.md, USER.md) → reset từ template"
  echo "  - Usage log, media cache, cron jobs, /tmp/clawdis"
  echo "  - Workspace files (AGENTS/SOUL/TOOLS/BOOTSTRAP) → reset từ template"
  echo
  echo -e "${GREEN}Giữ nguyên:${NC}"
  echo "  - ~/.clawdis/clawdis.json (API keys, models, Telegram token)"
  echo "  - ~/.clawdis/credentials/ (OAuth tokens)"
  echo "  - ~/.clawdis/skills/ (installed skills)"
  echo

  read -r -p "Nhập 'yes' để xác nhận: " confirm
  if [ "$confirm" != "yes" ]; then echo "Hủy."; exit 0; fi
  echo

  section "Xóa sessions..."
  safe_remove "$CLAWDIS_DIR/sessions"
  mkdir -p "$CLAWDIS_DIR/sessions"
  ok "sessions cleared"

  section "Xóa usage log..."
  safe_remove "$CLAWDIS_DIR/usage-log.jsonl"
  ok "usage-log cleared"

  section "Xóa cron jobs..."
  safe_remove "$CLAWDIS_DIR/cron"
  mkdir -p "$CLAWDIS_DIR/cron"
  ok "cron cleared"

  section "Xóa media cache..."
  safe_remove "$CLAWDIS_DIR/media"
  mkdir -p "$CLAWDIS_DIR/media"
  ok "media cleared"

  section "Xóa /tmp/clawdis..."
  safe_remove "/tmp/clawdis"
  ok "/tmp/clawdis cleared"

  section "Xóa agent memory..."
  safe_remove "$CLAWD_DIR/memory.md"
  safe_remove "$CLAWD_DIR/memory"
  safe_remove "$CLAWD_DIR/.clawdis/memory.sqlite"
  safe_remove "$CLAWD_DIR/.clawdis/memory.sqlite-wal"
  safe_remove "$CLAWD_DIR/.clawdis/memory.sqlite-shm"
  ok "memory cleared"

  section "Reset workspace files từ templates..."
  mkdir -p "$CLAWD_DIR"
  copy_template "AGENTS.md"
  copy_template "SOUL.md"
  copy_template "TOOLS.md"
  copy_template "IDENTITY.md"
  copy_template "USER.md"
  copy_template "BOOTSTRAP.md"

  echo
  ok "Done. Agent sẽ thấy BOOTSTRAP.md và bắt đầu ritual lần đầu gặp mặt."

  section "Restart gateway..."
  if systemctl --user restart clawdis-gateway.service 2>/dev/null; then
    sleep 2
    if systemctl --user is-active --quiet clawdis-gateway.service; then
      ok "clawdis-gateway.service restarted and active"
    else
      warn "clawdis-gateway.service restarted but not active — check: systemctl --user status clawdis-gateway.service"
    fi
  else
    warn "Could not restart clawdis-gateway.service — restart manually"
  fi
}

mode_nuke() {
  section "Mode: --nuke (Full Wipe)"
  echo -e "${RED}${BOLD}CẢNH BÁO: Xóa TOÀN BỘ kể cả config, API keys, Telegram token.${NC}"
  echo "Sau khi nuke, cần cấu hình lại clawdis.json từ đầu."
  echo
  echo "Xóa:"
  echo "  - Tất cả những gì --fresh xóa"
  echo "  - ~/.clawdis/clawdis.json (config, API keys)"
  echo "  - ~/.clawdis/credentials/"
  echo
  echo -e "${GREEN}Giữ nguyên:${NC}"
  echo "  - ~/.clawdis/skills/ (installed skills)"
  echo

  read -r -p "Nhập 'NUKE' (chữ hoa) để xác nhận: " confirm
  if [ "$confirm" != "NUKE" ]; then echo "Hủy."; exit 0; fi
  echo

  # Chạy fresh reset trước (không hỏi lại)
  section "Xóa sessions..."
  safe_remove "$CLAWDIS_DIR/sessions"
  mkdir -p "$CLAWDIS_DIR/sessions"

  section "Xóa usage log + cron + media..."
  safe_remove "$CLAWDIS_DIR/usage-log.jsonl"
  safe_remove "$CLAWDIS_DIR/cron"
  mkdir -p "$CLAWDIS_DIR/cron"
  safe_remove "$CLAWDIS_DIR/media"
  mkdir -p "$CLAWDIS_DIR/media"
  safe_remove "/tmp/clawdis"

  section "Xóa agent memory + workspace..."
  safe_remove "$CLAWD_DIR/memory.md"
  safe_remove "$CLAWD_DIR/memory"
  safe_remove "$CLAWD_DIR/.clawdis/memory.sqlite"
  safe_remove "$CLAWD_DIR/.clawdis/memory.sqlite-wal"
  safe_remove "$CLAWD_DIR/.clawdis/memory.sqlite-shm"

  section "Reset workspace files từ templates..."
  mkdir -p "$CLAWD_DIR"
  copy_template "AGENTS.md"
  copy_template "SOUL.md"
  copy_template "TOOLS.md"
  copy_template "IDENTITY.md"
  copy_template "USER.md"
  copy_template "BOOTSTRAP.md"

  section "Xóa config + credentials..."
  safe_remove "$CLAWDIS_DIR/clawdis.json"
  safe_remove "$CLAWDIS_DIR/credentials"
  ok "config + credentials cleared"

  echo
  ok "Done. Cần tạo lại ~/.clawdis/clawdis.json trước khi khởi động gateway."
}

# ─── Main ────────────────────────────────────────────────────────────────────

usage() {
  echo "Usage: $(basename "$0") [--fresh | --nuke]"
  echo
  echo "  --fresh  Reset agent về trạng thái lần đầu gặp mặt."
  echo "           Giữ: config (API keys, Telegram token), credentials, skills."
  echo "           Xóa: sessions, memory, identity, cron, media."
  echo
  echo "  --nuke   Xóa tất cả kể cả config. Cần cấu hình lại từ đầu."
  echo "           Giữ: skills."
  echo
  echo "Env vars:"
  echo "  CLAWDIS_DIR    (default: ~/.clawdis)"
  echo "  CLAWD_DIR      (default: agent.workspace in clawdis.json, fallback ~/clawd)"
  echo "  TEMPLATES_DIR  (default: <repo>/docs/templates)"
}

if [ $# -eq 0 ]; then usage; exit 1; fi

case "$1" in
  --fresh)   mode_fresh ;;
  --nuke)    mode_nuke ;;
  -h|--help) usage ;;
  *)
    echo "Unknown option: $1"
    usage
    exit 1
    ;;
esac
