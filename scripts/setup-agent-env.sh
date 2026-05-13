#!/usr/bin/env bash
# setup-agent-env.sh
# Usage: ./scripts/setup-agent-env.sh <target-folder>
#
# Creates .codex/ and .claude/ under the target folder,
# then copies CLAUDE.md and AGENTS.md from the repo root.

set -euo pipefail

# ── Argument validation ──────────────────────────────────────────────────────
if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <target-folder>" >&2
  exit 1
fi

TARGET="$1"

if [[ ! -d "$TARGET" ]]; then
  echo "Error: '$TARGET' is not an existing directory." >&2
  exit 1
fi

# ── Resolve script's own directory (repo root assumed to be the same dir) ────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CLAUDE_MD="$REPO_ROOT/CLAUDE.md"
AGENTS_MD="$REPO_ROOT/AGENTS.md"

if [[ ! -f "$CLAUDE_MD" ]]; then
  echo "Error: CLAUDE.md not found at '$CLAUDE_MD'." >&2
  exit 1
fi

if [[ ! -f "$AGENTS_MD" ]]; then
  echo "Error: AGENTS.md not found at '$AGENTS_MD'." >&2
  exit 1
fi

# ── Create directories ────────────────────────────────────────────────────────
mkdir -p "$TARGET/.codex"
echo "Created: $TARGET/.codex"

mkdir -p "$TARGET/.claude"
echo "Created: $TARGET/.claude"

# ── Copy files ────────────────────────────────────────────────────────────────
cp "$CLAUDE_MD" "$TARGET/.claude/CLAUDE.md"
echo "Copied:  CLAUDE.md  →  $TARGET/.claude/CLAUDE.md"

cp "$AGENTS_MD" "$TARGET/AGENTS.md"
echo "Copied:  AGENTS.md  →  $TARGET/AGENTS.md"

echo ""
echo "Done. Agent environment initialized at: $TARGET"
