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
| **DeepSeek Harness plugin** | 原生插件：哨兵条、`/guard check`、压缩后在 fork 子代理里后台自检，只把判定写回对话 |
| **Portable Agent Skill** | Claude Code / Codex 通用 `SKILL.md` + 两个零依赖 Python 脚本，用 git 工作区做证据核对 |

Both ask the same three questions and grade the answer the same way:

> **A. Can it recite the immovable constraints?**
> **B. Can it list the changed files with reasons?**
> **C. Can it give the next step and a runnable verify command?**

The model's own verdict is the baseline. Evidence only overrides it on hard
contradictions — a few omitted scratch files never turn a healthy conversation
yellow.

## Install · 安装

```sh
# DeepSeek Harness
dsh plugin --profile desktop add link:"$PWD/dsh-plugin"

# Claude Code
cp -r skill ~/.claude/skills/ctx-guard

# Codex
cp -r skill ~/.codex/skills/ctx-guard
```

Then run `/ctx-guard` (skill) or `/guard check` (DSH).

## Read more · 详细文档

- [English README](README.en.md) — full install, usage, verdict policy, tests
- [中文 README](README.zh-CN.md) — 完整安装、用法、判定规则、测试
- [Keeping up with DSH releases](docs/upgrading-dsh.md) — 升级维护清单
- [Verdict policy](skill/references/policy.md) — 判定阈值与取向

## Layout · 目录

```
dsh-plugin/          DeepSeek Harness plugin (host + client + tests)
skill/               Portable Agent Skill (Claude Code / Codex)
docs/upgrading-dsh.md Maintenance contract for DSH releases
```

## License

MIT
