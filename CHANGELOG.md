# Changelog

All notable changes to this project. The plugin and the skill share a version
until they diverge.

## Unreleased

- **External compression is detected and re-checked.** Proxy-level compressors
  (billion-context and friends) fold history without emitting DSH's
  `compaction/end`, so the post-compaction probe never fired. At each `turn/end`
  the sentinel now compares the measured request size and treats a ≥40% drop of
  a ≥10k-token request as a compression, re-running the check. The cooldown
  suppresses duplicates when a native compaction also fired.
- **billion-context alignment.** Its `compress.maxContextLimit` defaults to
  `"75%"`; docs recommend `pressureThreshold: 0.70` so the behavioral check
  runs before the fold, then again after it. Compression-triggered probes
  (native compaction and compression-drop) bypass the cooldown, because a fold
  rewrites working memory; pressure and step probes keep it.
- **Red verdicts are committed immediately.** `inject()` only lands on the next
  model step, so a manual `/guard check` that ended the turn left the projection
  empty: no red state, no popup, no dock. When the agent is not running, a red
  verdict is now delivered with `followup`, which wakes one step and writes the
  notice immediately. Green/yellow stay zero-cost injections.
- **The red popup survives a hidden dock.** It used to be rendered inside the
  dock component, which returns `null` after the user dismisses the status bar;
  the prompt now renders independently, and only the status bar stays hidden
  until `/guard show`.
- **Pressure and step triggers.** Besides compaction, a background check now
  fires when the next request would use `pressureThreshold` (default 60%) of the
  model window, or every `stepProbeInterval` steps. Long sessions that never
  compact are no longer untested; the trigger still never grades the result.
- **Red shows a yes/no handoff popup.** On 🔴 a small dialog appears above the
  composer ("写交接单" / "稍后"). Confirming calls the plugin's
  `POST /api/dsh-context-guard/handoff` endpoint, so the user types no command;
  the host wakes the model with a framework prompt and the model writes the
  document itself. `/guard handoff` does the same, and `/guard handoff draft`
  keeps the deterministic fallback.
- **Model-authored handoff.** The old flow wrote a sparse file from projection
  state, so the sections came out as "未提供". The instruction now demands the
  full session content (objective/acceptance, state with verified commands and
  results, decisions incl. rejected options, files with reasons, traps and failed
  attempts, 3–5 next steps, constraints), forbids "未提供/待补充" placeholders,
  and supplies the deterministic data (write log, pins, verify commands) as a
  cross-check. A 66-file session that produced an empty handoff now gets one with
  real content.
- **Seven-section handoff framework (fallback).** `buildHandoffMarkdown` emits
  objective/acceptance, current state with verified commands and results,
  decisions (including rejected options), files with reasons, known traps and
  failed attempts, 3–5 next steps, and constraints. The probe's optional machine
  fields (`objective`, `done`, `verified`, `decisions`, `failedAttempts`) feed it;
  the skill's `handoff.py` mirrors the same sections.
- Projection `STATE_VERSION` 5 → 6 so existing sessions re-fold with the richer
  report fields.
- **One-command installers.** `install.sh` (macOS/Linux) and `install.cmd` /
  `install.ps1` (Windows) copy the skill into `~/.claude/skills/ctx-guard`,
  `~/.codex/skills/ctx-guard`, or both. They honour `CLAUDE_SKILLS_DIR` and
  `CODEX_HOME`, skip `__pycache__`, and refuse to overwrite without `--force`.
- **Download docs** for people who do not clone: GitHub ZIP, manual copy, and
  the "no Node / no Python required" note.
- **Critical file-memory tier (recalibration).** Omitting ≥90% of the written
  files with at least 10 files now returns 🔴 instead of 🟡, and a report that
  lists no files when ≥10 were written is also 🔴. Real case: a kimi session
  wrote 64 files, the self-check listed 5 (92% omitted) and still self-reported
  green; obvious degradation was passing as a yellow warning. Few small
  omissions stay notes. Projection `STATE_VERSION` 4 → 5 so existing sessions
  are re-assessed on load. The portable skill's `guard.py` mirrors the tier.

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
