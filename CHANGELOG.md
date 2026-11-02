# Changelog

All notable changes to this project. The plugin and the skill share a version
until they diverge.

## Unreleased

- **One-command installers.** `install.sh` (macOS/Linux) and `install.cmd` /
  `install.ps1` (Windows) copy the skill into `~/.claude/skills/ctx-guard`,
  `~/.codex/skills/ctx-guard`, or both. They honour `CLAUDE_SKILLS_DIR` and
  `CODEX_HOME`, skip `__pycache__`, and refuse to overwrite without `--force`.
- **Download docs** for people who do not clone: GitHub ZIP, manual copy, and
  the "no Node / no Python required" note.

## 0.2.0 — 2026-11-02

### Plugin (`dsh-plugin`)

- **Background self-check.** `/guard check` and the post-compaction probe now run
  in a fork subagent that inherits the conversation's completed turns. The A/B/C
  answer stays in the child session; only the verdict is injected back into the
  parent chat.
- **`/guard check` returns the full status.** Check and status are merged: one
  command shows verdict, advice, report reasons and evidence counts. `/guard
  status` remains as a read-only view that spends no model call.
- **Evidence policy rebalanced.** The model's own verdict is the baseline; only
  hard contradictions (constraint amnesia, majority file omission, missing next
  step) demote it. Bookkeeping noise no longer turns a healthy conversation
  yellow.
- **Dock can be dismissed.** `×` hides the dock completely — no pill, no
  placeholder — while checks keep running in the background; `/guard show`
  restores it via a `dockEpoch` bump.
- **Fixes.** Resolve `subagents` through `ctx.get()` instead of a property
  access that cordis rejects without `inject`; always send `role: 'user'` with a
  stable `id` when injecting messages, so providers stop rejecting requests with
  `messages[n]: missing field role`.
- Projection `STATE_VERSION` 3 → 4 (fold semantics changed).

### Skill (`skill`)

- New portable Agent Skill for Claude Code / Codex and other Agent Skills
  harnesses: `SKILL.md`, `scripts/guard.py`, `scripts/handoff.py`,
  `references/policy.md`, python unit tests.
- Same verdict policy as the plugin; git working tree is the evidence baseline,
  with `--session-files` for harnesses that can list what they wrote.

## 0.1.0 — 2026-11-02

- Initial plugin: periodic three-test self-check after compaction, evidence
  cross-check, `/guard` commands, dock, handoff documents.
