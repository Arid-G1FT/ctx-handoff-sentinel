# 上下文交接哨兵

[English](README.en.md) · [中文](README.zh-CN.md)

在上下文开始腐烂之前，判断**这段对话还能不能自证**——而不是靠轮数、占用率或压缩次数猜。

同一个东西在这里有两种形态：

| 形态 | 给谁用 | 是什么 |
| --- | --- | --- |
| [`dsh-plugin/`](dsh-plugin) | DeepSeek Harness | 原生插件：哨兵条、`/guard check`、压缩后在 fork 子代理里后台自检，只把判定写回对话 |
| [`skill/`](skill) | Claude Code、Codex、任何 Agent Skills 宿主 | 通用 `SKILL.md` + 两个零依赖 Python 脚本，用同一套三项测试判分 |

两者遵循同一条规则：

> 压缩次数只是时间戳，判定必须是行为测试：
> **A. 还能不能复述不可动约束？**
> **B. 还能不能列出改过的文件和原因？**
> **C. 还能不能给出下一步和可执行的验证命令？**

## 为什么

长上下文不会突然报错，它会悄悄丢掉第 3 轮的那条约束、某个方案被否决的原因、或者哪个文件已经改过——然后模型开始重新讨论已经定下来的事。这种失效不主动检查是看不见的，所以判定必须看行为，不能看统计。

同样重要的是**别过度矫正**：漏了几个辅助脚本的健康对话，不该被判黄。证据核对从模型自评打底，只在硬矛盾时覆盖。完整规则见 [`skill/references/policy.md`](skill/references/policy.md)。

## 快速开始

### DeepSeek Harness

```sh
# 在仓库根目录
dsh plugin --profile desktop add link:"$PWD/dsh-plugin"
```

确认 profile 的 `dsh.profile.bundles` 里有 `@local/dsh-context-guard`。然后**完全重启应用**（Host 侧代码在启动时加载；只改客户端才只需刷新页面）。

对话里的命令：

| 命令 | 作用 |
| --- | --- |
| `/guard check` | 做一次自检，**直接返回完整状态**（判定 + 建议 + 报告 + 证据） |
| `/guard status` | 只读状态，不发起自检、不花模型调用 |
| `/guard handoff` | 写一份交接单到 `.dsh-handoff/` |
| `/guard pin <约束>` | 固定一条不可动约束，之后每次自检都要复述 |
| `/guard green\|yellow\|red [原因]` | 人工判定（优先于自动核对） |
| `/guard show` | 恢复被 `×` 隐藏的哨兵条 |
| `/guard reset` | 清空当前自检/判定 |

### Claude Code

```sh
mkdir -p ~/.claude/skills
cp -r skill ~/.claude/skills/ctx-guard
```

然后输入 `/ctx-guard`，或者直接问「是不是该开新对话了」——描述会让 Claude 自动加载。

### Codex

```sh
mkdir -p ~/.codex/skills
cp -r skill ~/.codex/skills/ctx-guard
```

Codex 读取 `~/.codex/skills/<name>/SKILL.md`，同一套 Agent Skills 格式。可以显式调用，也可以靠描述自动触发。

### 其他宿主

把 [`skill/SKILL.md`](skill/SKILL.md) 交给 agent，并给它一个 shell。脚本是零依赖 Python 3（3.9+）；没有 Python 时，skill 会退化为按规则手工判分。

## 通用 skill 实际跑什么

```sh
# 1. 模型把三项测试的答案写成 JSON 报告（schema 见 skill/SKILL.md）
python3 skill/scripts/guard.py --root . --report .ctx-guard/report.json

# 2. 可选：把同一份报告变成交接单
python3 skill/scripts/handoff.py --root . --report .ctx-guard/report.json
```

`guard.py` 用 git 工作区做证据基线（宿主能列出写过的文件时，也可以用 `--session-files` 传）。退出码 `0` = 绿/黄，`2` = 红，`1` = 输入格式错误。

skill 刻意让 A/B/C 答案**不进用户的对话**：模型写到临时文件，脚本判分，只打印判定块。

## 判定规则（速查）

| 硬矛盾 | 判定 |
| --- | --- |
| 报告承认记不清约束/规则 | 🔴 |
| 工作区改了 ≥3 个文件，报告一个没列 | 🟡 |
| 漏报超过一半（且 ≥2 个） | 🟡 |
| 报告里 ≥3 个文件不在基线、且占报告一半以上 | 🟡 |
| 没有下一步，或没有可执行验证命令 | 🟡 |

其余一律只记提示、不降级：少量漏报、git 看不到的 shell 写入、诚实说明的不确定项、原因写得短、没有固定约束时写「无」。完整规则与阈值见 [`skill/references/policy.md`](skill/references/policy.md)。

## 目录结构

```
dsh-plugin/          DeepSeek Harness 插件（宿主 + 客户端 + 测试）
skill/               通用 Agent Skill
  SKILL.md           触发条件、协议、输出契约
  scripts/guard.py   确定性证据核对
  scripts/handoff.py 七段式交接单
  references/        判定规则
  tests/             Python 单元测试
docs/upgrading-dsh.md  DSH 升级维护清单
```

## 测试

```sh
# 插件（逐个文件跑；`node --test test/` 会 spawn 子进程，某些沙箱会拦）
node dsh-plugin/test/core.test.mjs
node dsh-plugin/test/host.test.mjs
node dsh-plugin/test/client.test.mjs

# skill
python -m unittest discover -s skill/tests -p "test_*.py"
```

## 跟着 DSH 版本升级

插件只依赖公开的 harness 接口，但 DSH 还在 pre-1.0，接口会动。[`docs/upgrading-dsh.md`](docs/upgrading-dsh.md) 列了完整的依赖面、五分钟升级清单和版本号规则。

一句话版：把 `engines.dsh` 更新到实测过的版本 → 跑测试 → 重启 → `/guard check` 冒烟 → 折叠语义变了就升 `STATE_VERSION`。

## License

MIT — 见 [LICENSE](LICENSE)。
