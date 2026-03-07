#!/usr/bin/env bash
# reset-workspace.sh — openclaw workspace reset tool
#
# Usage:
#   ./scripts/reset-workspace.sh --full          Factory reset (xóa tất cả state, giữ config+credentials)
#   ./scripts/reset-workspace.sh --soft          Update templates only (giữ identity + memory)
#   ./scripts/reset-workspace.sh --conversations Chỉ xóa chat history + analytics
#
# Các path có thể override bằng env vars:
#   CLAWDIS_DIR   (default: ~/.clawdis)
#   CLAWD_DIR     (default: ~/clawd)
#   TEMPLATES_DIR (default: script's ../docs/templates)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CLAWDIS_DIR="${CLAWDIS_DIR:-$HOME/.clawdis}"
CLAWD_DIR="${CLAWD_DIR:-$HOME/clawd}"
TEMPLATES_DIR="${TEMPLATES_DIR:-$REPO_ROOT/docs/templates}"

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
    mv "$target" "$backup/" && info "moved to backup: $backup/$(basename "$target")"
  fi
}

safe_remove_glob() {
  local dir="$1"
  local pattern="$2"
  if [ ! -d "$dir" ]; then return 0; fi
  # shellcheck disable=SC2086
  local files=("$dir"/$pattern)
  for f in "${files[@]}"; do
    [ -e "$f" ] && safe_remove "$f"
  done
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
  ok "template copied: $name"
}

# ─── Reset actions ──────────────────────────────────────────────────────────

clear_sessions() {
  section "Xóa sessions..."
  safe_remove "$CLAWDIS_DIR/sessions"
  mkdir -p "$CLAWDIS_DIR/sessions"
  ok "sessions cleared"
}

clear_usage_log() {
  section "Xóa usage log..."
  safe_remove "$CLAWDIS_DIR/usage-log.jsonl"
  ok "usage-log cleared"
}

clear_cron() {
  section "Xóa cron jobs..."
  safe_remove "$CLAWDIS_DIR/cron"
  mkdir -p "$CLAWDIS_DIR/cron"
  ok "cron cleared"
}

clear_media() {
  section "Xóa media cache..."
  safe_remove "$CLAWDIS_DIR/media"
  mkdir -p "$CLAWDIS_DIR/media"
  ok "media cleared"
}

clear_tmp() {
  section "Xóa /tmp/clawdis..."
  safe_remove "/tmp/clawdis"
  ok "/tmp/clawdis cleared"
}

clear_agent_memory() {
  section "Xóa agent memory..."
  safe_remove "$CLAWD_DIR/memory.md"
  safe_remove "$CLAWD_DIR/memory"
  safe_remove "$CLAWD_DIR/.clawdis/memory.sqlite"
  ok "agent memory cleared"
}

reset_workspace_templates() {
  # Overwrite AGENTS.md, SOUL.md, TOOLS.md từ template
  section "Reset workspace templates..."
  mkdir -p "$CLAWD_DIR"
  copy_template "AGENTS.md"
  copy_template "SOUL.md"
  copy_template "TOOLS.md"
}

reset_all_workspace_files() {
  # Full reset: tất cả 6 file + tạo lại BOOTSTRAP.md
  section "Reset tất cả workspace files..."
  mkdir -p "$CLAWD_DIR"
  copy_template "AGENTS.md"
  copy_template "SOUL.md"
  copy_template "TOOLS.md"
  copy_template "IDENTITY.md"
  copy_template "USER.md"
  copy_template "BOOTSTRAP.md"
  ok "BOOTSTRAP.md tạo lại — agent sẽ bootstrap khi vào session tiếp theo"
}

# ─── Modes ──────────────────────────────────────────────────────────────────

mode_conversations() {
  section "Mode: --conversations"
  info "Xóa chat history và analytics, giữ identity + memory + cron"
  echo

  clear_sessions
  clear_usage_log
  clear_media
  clear_tmp

  echo
  ok "Done. Agent identity, memory, cron jobs còn nguyên."
  ok "Session tiếp theo: agent tiếp tục như cũ nhưng không có chat history."
}

mode_soft() {
  section "Mode: --soft"
  info "Update templates (AGENTS/SOUL/TOOLS), giữ identity + memory + tất cả ~/.clawdis/"
  echo

  reset_workspace_templates

  echo
  ok "Done. Agent nhận hướng dẫn mới từ templates, nhưng vẫn nhớ mọi thứ."
  warn "Gợi ý: restart gateway để áp dụng — systemctl --user restart clawdis-gateway.service"
}

mode_full() {
  section "Mode: --full (Factory Reset)"
  echo -e "${RED}${BOLD}CẢNH BÁO: Thao tác này sẽ xóa TOÀN BỘ agent state:${NC}"
  echo "  - Tất cả chat sessions và history"
  echo "  - Usage analytics"
  echo "  - Cron jobs và run logs"
  echo "  - Agent identity (IDENTITY.md, USER.md)"
  echo "  - Toàn bộ memory (memory.md, memory/, memory.sqlite)"
  echo "  - Media cache và /tmp/clawdis"
  echo
  echo -e "${GREEN}Giữ nguyên:${NC}"
  echo "  - ~/.clawdis/clawdis.json (config, API keys)"
  echo "  - ~/.clawdis/credentials/ (OAuth tokens)"
  echo "  - ~/.clawdis/skills/ (installed skills)"
  echo

  read -r -p "Nhập 'yes' để xác nhận factory reset: " confirm
  if [ "$confirm" != "yes" ]; then
    echo "Hủy."
    exit 0
  fi

  echo

  clear_sessions
  clear_usage_log
  clear_cron
  clear_media
  clear_tmp
  clear_agent_memory
  reset_all_workspace_files

  echo
  ok "Factory reset hoàn tất."
  ok "Session tiếp theo: agent sẽ thấy BOOTSTRAP.md và bắt đầu ritual đặt tên."
  warn "Gợi ý: restart gateway — systemctl --user restart clawdis-gateway.service"
}

# ─── Main ────────────────────────────────────────────────────────────────────

usage() {
  echo "Usage: $(basename "$0") [--full | --soft | --conversations]"
  echo
  echo "  --full           Factory reset: xóa tất cả state, giữ config + credentials + skills"
  echo "  --soft           Update templates: giữ identity, memory, tất cả ~/.clawdis/"
  echo "  --conversations  Xóa chat history + analytics: giữ identity, memory, cron"
  echo
  echo "Env vars:"
  echo "  CLAWDIS_DIR    (default: ~/.clawdis)"
  echo "  CLAWD_DIR      (default: ~/clawd)"
  echo "  TEMPLATES_DIR  (default: <repo>/docs/templates)"
}

if [ $# -eq 0 ]; then
  usage
  exit 1
fi

case "$1" in
  --full)          mode_full ;;
  --soft)          mode_soft ;;
  --conversations) mode_conversations ;;
  -h|--help)       usage ;;
  *)
    echo "Unknown option: $1"
    usage
    exit 1
    ;;
esac
