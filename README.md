<div align="center">

# Context handoff sentinel

**Decide whether a conversation can still prove itself — from behavior, not from turn count.**

[English](README.en.md) · [中文](README.zh-CN.md)

</div>

---

## What it is · 是什么

Two forms of the same check:

| | |
| --- | --- |
| **DeepSeek Harness plugin** | 原生插件：哨兵条、`/guard check`、fork 子代理后台自检（压缩 / 上下文压力 / 步数触发），判红时主动问是否写交接单 |
| **Portable Agent Skill** | Claude Code / Codex 通用 `SKILL.md` + 两个零依赖 Python 脚本，用 git 工作区做证据核对 |

Both ask the same three questions and grade the answer the same way:

> **A. Can it recite the immovable constraints?**
> **B. Can it list the changed files with reasons?**
> **C. Can it give the next step and a runnable verify command?**

The model's own verdict is the baseline. Evidence only overrides it on hard
contradictions — a few omitted scratch files never turn a healthy conversation
yellow.

## Get it · 获取

**Clone + one-command installer** (macOS / Linux / Windows):

```sh
git clone https://github.com/Arid-G1FT/ctx-handoff-sentinel.git
cd ctx-handoff-sentinel

# macOS / Linux
./install.sh --both        # or --claude / --codex; --force to overwrite

# Windows (double-click install.cmd also works)
install.cmd -Force
```

**No git? Download the ZIP**: GitHub → **Code → Download ZIP** → extract → run
`install.sh` / `install.cmd` from the extracted folder.

**No installer needed**: the skill is just files. Copy `skill/` into
`~/.claude/skills/ctx-guard` (Claude Code) or `~/.codex/skills/ctx-guard`
(Codex). No Node, no npm — Python 3.9+ is optional (only for the verdict
script; the skill falls back to applying the policy by hand).

**DeepSeek Harness plugin**:

```sh
dsh plugin --profile desktop add link:"$PWD/dsh-plugin"
```

Requires restarting the app afterwards.

## Read more · 详细文档

- [English README](README.en.md) — full install, usage, verdict policy, tests
- [中文 README](README.zh-CN.md) — 完整安装、用法、判定规则、测试
- [Keeping up with DSH releases](docs/upgrading-dsh.md) — 升级维护清单
- [Publishing to the DSH plugin market](docs/publishing.md) — 上架插件市场的步骤
- [Verdict policy](skill/references/policy.md) — 判定阈值与取向

## Layout · 目录

```
dsh-plugin/          DeepSeek Harness plugin (host + client + tests)
skill/               Portable Agent Skill (Claude Code / Codex)
docs/upgrading-dsh.md Maintenance contract for DSH releases
```

## License

MIT
