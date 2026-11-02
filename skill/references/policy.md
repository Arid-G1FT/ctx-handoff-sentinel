# Verdict policy

The sentinel answers one question: **can the current context still prove itself?**
Not "is the conversation long", not "did a compaction happen". Those are triggers,
never verdicts.

## Three tests

| Test | Question | What a good answer looks like |
| --- | --- | --- |
| A. Constraints | Which immovable constraints are still in force? | Named, sourced, and still correct |
| B. Files | What actually changed, why, and what does one key line look like? | File-level detail, reasons, a real line |
| C. Next step | What happens next, and what command proves it? | A concrete action and a runnable command |

## Evidence cross-check

The model's self-verdict is the **baseline**. `guard.py` only overrides it on a
hard contradiction:

| Hard contradiction | Verdict | Why it matters |
| --- | --- | --- |
| `unknowns` admits it cannot recall constraints/rules | 🔴 | The context already lost the thing that must not be lost |
| ≥90% of changed files omitted (and ≥10 files) | 🔴 | File memory is effectively gone; only the last task survives |
| Changed files exist but the report lists none (≥10 written) | 🔴 | Same failure at its extreme: no account of the session's work |
| ≥3 changed files in the tree, none listed (fewer than 10) | 🟡 | The model has stopped tracking its own work |
| More than half of changed files omitted (≥2) | 🟡 | The file memory is broadly wrong, not just noisy |
| ≥3 reported files absent from the baseline and dominant | 🟡 | Possible fabrication; confirm with a spot check |
| No next step, or no runnable verify command | 🟡 | The session cannot continue without re-deriving the plan |

The second red row is what a real 1M-context kimi session looked like: 64 files
written, 5 listed (92% omitted), the model still self-reported green. Capping
that at yellow let obvious degradation through — the missing-file tier now has a
red branch.

## What does **not** demote

- A few omitted helper files (`scripts/*`, scratch artifacts).
- Shell-written paths that git cannot see (`git status` misses ignored output).
- Honestly declared unknowns — that is the test working.
- Short reasons on one or two files.
- No constraints, when nothing was pinned.

Rationale: the old rule set graded every bookkeeping blemish as a demotion, which
turned a healthy 29%-context conversation yellow. Evidence is for catching real
breakage, not for nitpicking.

## Calibration

- After the same failure appears twice on the same model/task class, tighten the
  threshold by one level for that combination.
- A 🔴 for constraint amnesia is never negotiable; that is the failure the test
  exists to catch.
- Manual override always wins: record `/guard red <reason>`-style judgement in
  the handoff document.

## Thresholds

`MISSING_RATIO_YELLOW = 0.5`, `MISSING_COUNT_YELLOW = 2`,
`MISSING_RATIO_RED = 0.9`, `MISSING_COUNT_RED = 10`,
`PHANTOM_RATIO_YELLOW = 0.5`, `PHANTOM_COUNT_YELLOW = 3`,
`NO_FILES_REPORTED_MIN_ACTUAL = 3` — all in `scripts/guard.py`, tunable per team.
