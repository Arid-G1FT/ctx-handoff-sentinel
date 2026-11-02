#!/usr/bin/env sh
# Install the ctx-guard Agent Skill for Claude Code and/or Codex.
#
#   ./install.sh            # both, when both homes exist
#   ./install.sh --claude   # ~/.claude/skills/ctx-guard
#   ./install.sh --codex    # ~/.codex/skills/ctx-guard
#   ./install.sh --force    # overwrite an existing install
#
# Overrides (useful for tests and non-standard homes):
#   CLAUDE_SKILLS_DIR, CODEX_HOME
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_DIR="$ROOT/skill"

if [ ! -f "$SKILL_DIR/SKILL.md" ]; then
  echo "ctx-guard: skill/SKILL.md not found next to this script ($ROOT)" >&2
  exit 1
fi

WANT_CLAUDE=0
WANT_CODEX=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --claude) WANT_CLAUDE=1 ;;
    --codex) WANT_CODEX=1 ;;
    --both) WANT_CLAUDE=1; WANT_CODEX=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "ctx-guard: unknown option $arg" >&2; exit 1 ;;
  esac
done

if [ "$WANT_CLAUDE" -eq 0 ] && [ "$WANT_CODEX" -eq 0 ]; then
  WANT_CLAUDE=1
  WANT_CODEX=1
fi

CLAUDE_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}/skills"

install_into() {
  label=$1
  dest=$2
  if [ -e "$dest" ] && [ "$FORCE" -eq 0 ]; then
    echo "ctx-guard: $label already exists at $dest (use --force to overwrite)" >&2
    return 1
  fi
  mkdir -p "$(dirname -- "$dest")"
  rm -rf "$dest"
  mkdir -p "$dest"
  (cd "$SKILL_DIR" && tar -cf - --exclude='__pycache__' --exclude='*.pyc' .) | (cd "$dest" && tar -xf -)
  find "$dest" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
  find "$dest" -type f -name '*.pyc' -delete 2>/dev/null || true
  chmod +x "$dest/scripts/guard.py" "$dest/scripts/handoff.py" 2>/dev/null || true
  echo "ctx-guard: installed $label -> $dest"
}

STATUS=0
if [ "$WANT_CLAUDE" -eq 1 ]; then
  install_into "Claude Code" "$CLAUDE_DIR/ctx-guard" || STATUS=1
fi
if [ "$WANT_CODEX" -eq 1 ]; then
  install_into "Codex" "$CODEX_DIR/ctx-guard" || STATUS=1
fi

if [ "$STATUS" -eq 0 ]; then
  echo ""
  echo "Next: run /ctx-guard in a session, or ask \"should I start a new conversation?\"."
fi
exit "$STATUS"
