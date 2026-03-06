#!/bin/bash
# Security review script using Claude Code + z.ai
# Usage: ./scripts/security-review.sh [PR_NUMBER]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REVIEW_TOOL_DIR="${REVIEW_TOOL_DIR:-/tmp/claude-code-security-review}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${YELLOW}[Security Review]${NC} Starting security analysis..."

# Check if review tool is installed
if [ ! -d "$REVIEW_TOOL_DIR" ]; then
  echo -e "${YELLOW}[Security Review]${NC} Cloning security review tool..."
  git clone https://github.com/anthropics/claude-code-security-review.git "$REVIEW_TOOL_DIR" 2>/dev/null || true
fi

# Install/update dependencies
if ! python3 -c "import claudecode" 2>/dev/null; then
  echo -e "${YELLOW}[Security Review]${NC} Installing dependencies..."
  pip install -q -r "$REVIEW_TOOL_DIR/claudecode/requirements.txt"
fi

# Check environment
if [ -z "${ANTHROPIC_AUTH_TOKEN:-}" ]; then
  echo -e "${RED}[Security Review]${NC} Error: ANTHROPIC_AUTH_TOKEN not set"
  echo "Add to ~/.zshrc or ~/.bashrc:"
  echo "  export ANTHROPIC_AUTH_TOKEN='your-token'"
  exit 1
fi

# Load .env if exists in openclaw
if [ -f "$REPO_ROOT/.env" ]; then
  echo -e "${YELLOW}[Security Review]${NC} Loading .env from $REPO_ROOT"
  set -a
  source "$REPO_ROOT/.env"
  set +a
fi

# Ensure z.ai config
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-https://api.z.ai/api/anthropic}"
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-glm-4.7}"

echo -e "${GREEN}[Security Review]${NC} Using model: $ANTHROPIC_MODEL"
echo -e "${GREEN}[Security Review]${NC} Using base URL: $ANTHROPIC_BASE_URL"

# Run security review on PR or local changes
PR_NUMBER="${1:-}"

if [ -z "$PR_NUMBER" ]; then
  echo -e "${YELLOW}[Security Review]${NC} Analyzing uncommitted changes..."
  cd "$REVIEW_TOOL_DIR"
  python3 -m claudecode.audit --repo-path "$REPO_ROOT"
else
  echo -e "${YELLOW}[Security Review]${NC} Analyzing PR #$PR_NUMBER..."
  cd "$REVIEW_TOOL_DIR"
  python3 -m claudecode.github_action_audit \
    --repo "$(cd "$REPO_ROOT" && git config --get remote.origin.url | sed 's/.*[:/]\([^:/]*\)\/\([^/]*\).*/\1\/\2/')" \
    --pr-number "$PR_NUMBER" \
    --github-token "${GITHUB_TOKEN:-}"
fi

echo -e "${GREEN}[Security Review]${NC} Analysis complete!"
