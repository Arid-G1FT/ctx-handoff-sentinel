---
name: ctx-guard
description: Behavioral context self-check before a handoff. Use when the user asks whether the conversation is getting too long, after a context compaction, when the model starts repeating rejected plans or forgetting edited files, or whenever starting a fresh session is being considered. Runs three recall tests, cross-checks them against the real working tree, and returns a green/yellow/red verdict plus an optional handoff document.
argument-hint: "[check|handoff] [reason]"
allowed-tools: Bash(python3:*), Bash(python:*), Bash(git status:*), Bash(git diff:*), Read, Write
---

# Context handoff sentinel

Decide **whether the current context can still prove itself**, then hand off if it
cannot. Never decide from turn count, context percentage, or compaction count:
those say when to *test*, not whether to leave.

## When to run

- The user asks "should I start a new conversation", "is this context getting
  stale", or invokes `/ctx-guard`.
- The host reports a context compaction.
- You notice degradation: repeating a rejected plan, forgetting which files you
  edited, two versions of the same fact, needing the same constraint re-explained.
- Before writing a handoff document for another session.

## Protocol — run this silently

Do not dump the questionnaire into the conversation. The user wants the verdict,
not the exam.

1. **Read the ground truth** (do not let it influence your answers): `git status
   --porcelain` and `git diff --stat`. If this is not a git repository, say so in
   the evidence line and rely on what you actually wrote this session.
2. **Answer the three questions from memory only.** Do not grep/read files to
   reconstruct the answers; that would test the filesystem, not the context.
   - A. Immovable constraints still in force, each with its source.
   - B. Files actually changed this session, with *what* and *why*, and one key
     line you still remember from one of them.
   - C. The next step and a runnable verification command.
   If you cannot recall something, say so in `unknowns` — honesty is the point.
3. **Write the report JSON** to `.ctx-guard/report.json` in the workspace:

   ```json
   {
     "verdict": "green|yellow|red",
     "objective": "one line: what this session set out to finish",
     "constraints": [{"text": "do not touch X", "source": "user", "certain": true}],
     "files": [{"path": "src/a.ts", "change": "added null guard", "reason": "crash on empty input", "certain": true}],
     "nextStep": "run the migration and check the failing test",
     "verify": ["npm test -- src/a.test.ts"],
     "unknowns": ["whether the staging flag was enabled"],
     "decisions": ["chose a queue over polling because the API rate-limits"],
     "failedAttempts": ["retrying with a 100ms sleep still hit 429"],
     "spotCheckFile": "src/a.ts"
   }
   ```

   `objective`, `decisions`, and `failedAttempts` are optional but make the
   handoff far more useful.
4. **Run the evidence check** from the workspace root:

   ```sh
   python3 "$SKILL_DIR/scripts/guard.py" --root . --report .ctx-guard/report.json
   ```

   `$SKILL_DIR` is the directory containing this SKILL.md (Claude Code exposes it
   as `${CLAUDE_SKILL_DIR}`; Codex users pass the path explicitly). On Windows use
   `python` when `python3` is missing. If Python is unavailable, apply the policy
   below by hand and print the same verdict block.
5. **Print only the verdict block** the script returns, verbatim. No A/B/C dump.
6. **Handoff** when the user asked for one or the verdict is red:

   ```sh
   python3 "$SKILL_DIR/scripts/handoff.py" --root . --report .ctx-guard/report.json
   ```

   Print the returned path and the opener from the document.

Exit code `2` from `guard.py` means **red**, not a crash; still print its output.

## Verdict policy (what the script enforces)

The model's own verdict is the baseline. Evidence overrides it only on hard
contradictions:

| Hard contradiction | Verdict |
| --- | --- |
| The report admits it cannot recall the constraints/rules | 🔴 |
| The working tree changed ≥3 files but the report lists none | 🟡 |
| The report omits more than half of the changed files (and ≥2) | 🟡 |
| ≥3 reported files are absent from the baseline and dominate the report | 🟡 |
| No next step, or no runnable verification command | 🟡 |

Everything else is a **note, not a demotion**: a few omitted helper files,
shell-written paths outside git, honestly declared unknowns, short reasons,
"no constraints" when nothing was pinned.

Rationale: a healthy conversation must not be graded yellow for omitting scratch
files. Full rules: `references/policy.md`.

## Reporting format

```
ctx-guard · 🟡 YELLOW
reasons: ...
notes: ...
evidence: 12 changed · 7 reported · 5 missing · 0 unverified (baseline: git working tree)
```

Keep it to that block. If the user wants the detail, they can open
`.ctx-guard/report.json` or ask.

## After the verdict

- 🟢 **green** — keep working; the context still proves itself.
- 🟡 **yellow** — finish only the current sub-goal, do not expand scope, then
  run the handoff step.
- 🔴 **red** — stop adding work. Write the handoff now and start a fresh session
  from the document.
