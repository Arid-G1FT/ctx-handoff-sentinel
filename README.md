# Context handoff sentinel

Decide **whether a conversation can still prove itself** before the context rots —
instead of guessing from turn count, context percentage, or compaction count.

This repository ships the same idea in two forms:

| Form | For | What it is |
| --- | --- | --- |
| [`dsh-plugin/`](dsh-plugin) | DeepSeek Harness | Native plugin: watchdog dock, `/guard check`, background self-check in a fork subagent, verdict written back to the conversation |
| [`skill/`](skill) | Claude Code, Codex, any Agent Skills harness | Portable `SKILL.md` + two dependency-free Python scripts that grade the same three tests |

Both follow one rule:

> The number of compactions is a timestamp. The verdict is behavioral:
> **A. can it recite the immovable constraints?**
> **B. can it list the changed files with reasons?**
> **C. can it give the next step and a runnable verify command?**

## Why

Long contexts do not fail loudly. They fail by quietly losing the constraint from
turn 3, the reason a plan was rejected, or which file was already edited — and
then the model starts re-litigating settled decisions. The failure is invisible
until you look for it, so the check has to be behavioral, not statistical.

Equally important: **do not over-correct**. A healthy conversation must not be
graded yellow because it omitted a few scratch files. The evidence check starts
from the model's own verdict and only overrides it on hard contradictions. See
[`skill/references/policy.md`](skill/references/policy.md).

## Quick start

### DeepSeek Harness

```sh
# from a clone of this repo
dsh plugin --profile desktop add link:"$PWD/dsh-plugin"
```

Then add `@local/dsh-context-guard` to the profile's `dsh.profile.bundles`
(already done on the author's machine). Restart the app; **host changes require a
full restart**, client-only changes need a page refresh.

Commands inside a conversation:

| Command | Effect |
| --- | --- |
| `/guard check` | Run a self-check and return the full verdict (green/yellow/red + reasons + evidence) |
| `/guard status` | Read-only status, no self-check, no model call |
| `/guard handoff` | Write a handoff document under `.dsh-handoff/` |
| `/guard pin <constraint>` | Pin an immovable constraint that every check must recite |
| `/guard green\|yellow\|red [reason]` | Record a manual verdict (wins over evidence) |
| `/guard show` | Restore the dock after `×` hid it |
| `/guard reset` | Clear the current check/verdict |

### Claude Code

```sh
mkdir -p ~/.claude/skills
cp -r skill ~/.claude/skills/ctx-guard
```

Then run `/ctx-guard`, or just ask "should I start a new conversation?" — the
description lets Claude load it automatically.

### Codex

```sh
mkdir -p ~/.codex/skills
cp -r skill ~/.codex/skills/ctx-guard
```

Codex loads `~/.codex/skills/<name>/SKILL.md` with the same Agent Skills format.
Invoke it explicitly (`ctx-guard`) or let it trigger from the description.

### Any other harness

Point the agent at [`skill/SKILL.md`](skill/SKILL.md) and give it a shell. The
scripts are dependency-free Python 3 (3.9+); without Python the skill falls back
to applying the policy by hand.

## What the portable skill runs

```sh
# 1. the model answers the three tests into a JSON report
#    (see skill/SKILL.md for the schema)
python3 skill/scripts/guard.py --root . --report .ctx-guard/report.json

# 2. optional: turn the same report into a handoff document
python3 skill/scripts/handoff.py --root . --report .ctx-guard/report.json
```

`guard.py` uses the git working tree as ground truth (or a session write log via
`--session-files` when your harness can list what it wrote). Exit code `0` means
green/yellow, `2` means red, `1` means malformed input.

The skill deliberately keeps the A/B/C answer **out of the user's conversation**:
the model writes it to a temp file, the script grades it, and only the verdict
block is printed.

## Verdict policy (short version)

| Hard contradiction | Verdict |
| --- | --- |
| Report admits it cannot recall constraints/rules | 🔴 |
| ≥3 files changed, report lists none | 🟡 |
| More than half of changed files omitted (and ≥2) | 🟡 |
| ≥3 reported files absent from the baseline and dominant | 🟡 |
| No next step, or no runnable verify command | 🟡 |

Everything else is a note, never a demotion: a few omitted helper files,
shell-written paths outside git, honestly declared unknowns, short reasons,
"no constraints" when nothing was pinned. Full rules and thresholds:
[`skill/references/policy.md`](skill/references/policy.md).

## Repository layout

```
dsh-plugin/          DeepSeek Harness plugin (host + client + tests)
skill/               Portable Agent Skill
  SKILL.md           protocol, triggers, output contract
  scripts/guard.py   deterministic evidence check
  scripts/handoff.py seven-section handoff document
  references/        verdict policy
  tests/             python unit tests
docs/upgrading-dsh.md  how to keep the plugin working across DSH releases
```

## Tests

```sh
# plugin (run each file; `node --test test/` spawns children that some sandboxes block)
node dsh-plugin/test/core.test.mjs
node dsh-plugin/test/host.test.mjs
node dsh-plugin/test/client.test.mjs

# skill
python -m unittest discover -s skill/tests -p "test_*.py"
```

## Keeping up with DSH releases

The plugin only uses public harness seams, but DSH is still pre-1.0 and those
seams can move. [`docs/upgrading-dsh.md`](docs/upgrading-dsh.md) lists the exact
surface, a five-minute upgrade checklist, and the version-bump rules.

Short version: update `engines.dsh` to the releases you actually tested, run the
tests, restart the app, run `/guard check` once, and bump the projection
`STATE_VERSION` whenever the fold semantics change.

## 中文说明

同一个东西的两种形态：`dsh-plugin/` 是 DeepSeek Harness 原生插件（哨兵条、
`/guard check`、后台 fork 子代理自检）；`skill/` 是 Claude Code / Codex 通用的
Agent Skill（`SKILL.md` + 两个零依赖 Python 脚本）。

判定规则一致：**模型自评打底，证据只在硬矛盾时降级**。漏几个辅助脚本、
shell 写入的文件、诚实说明的不确定项，都只记提示，不判黄。

安装：插件按上面的 `dsh plugin add link:`，skill 直接拷到
`~/.claude/skills/ctx-guard` 或 `~/.codex/skills/ctx-guard`。

## License

MIT — see [LICENSE](LICENSE).
