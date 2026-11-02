# DSH Context Guard（上下文交接哨兵）

`dsh-context` 回答的是「上下文里有什么」；这个插件回答的是「当前上下文还能不能自证」。它配合 `dsh-context` 使用，在每次压缩后立即做三项**行为测试**，只有测试结果才决定是否交接：

| 结果 | 判定 | 动作 |
| --- | --- | --- |
| 三项全对，细节到文件/命令级 | 🟢 | 可继续，甚至可以扩范围 |
| 约束对，但文件或原因开始模糊 | 🟡 | 只把当前子目标做完，不再扩范围 |
| 约束复述错，或开始编造 | 🔴 | 立即交接，无论才压缩了几次 |

## 为什么不是「压缩了几次」

压缩次数只是元数据，不能证明模型当前还记得什么。一个模型可以只压缩一次就把约束记错，也可以在多次压缩后仍然准确。这个插件因此把压缩当作**触发器**，把三项行为测试当作**判定门**：

1. 让它逐条列出当前不可动的约束（不是「你还记得吗」，而是「列出来」）；
2. 让它列出本会话实际改过的文件和每处原因，并指出一处可抽检的位置；
3. 让它说出下一步和可直接执行的验证命令。

插件不会把答案提前喂给模型。它只负责在压缩后把这三问送进下一轮，然后拿模型的回答和会话日志里的真实证据做核对。

## 工作方式

```
成功的 compaction/end
        │
        ▼
┌──────────────────────────────────────┐
│ 在 fork 子代理里跑三项自检            │  ← 子代理继承本对话，A/B/C 不进你的对话
└──────────────────────────────────────┘
        │
        ▼
子代理回答 A 约束 / B 文件+原因 / C 下一步+验证命令
并在末尾输出：DSH_GUARD_JSON: {...}
        │
        ▼
插件把回答与会话日志核对：
  · 实际写入过哪些文件（原生 write/edit/str_replace_editor）
  · 用户用 /guard pin 固定过哪些约束
  · 报告有没有漏文件、编造文件、缺原因、缺验证命令
        │
        ▼
只把判定写回对话：🟢 / 🟡 / 🔴 + 理由 + 证据计数
（A/B/C 正文留在子代理会话里，不落主对话）
```

**结构信号只负责「什么时候测」**：一次成功压缩、以及手动 `/guard check`。是否交接始终由三项行为测试决定，而不是由 token 数或压缩次数决定。这样也天然适配任何模型：测的是此刻这个模型的真实状态。

## 安装

克隆本仓库后，把插件目录作为本地 bundle 链入 profile：

```sh
dsh plugin --profile desktop add link:/path/to/ctx-handoff-sentinel/dsh-plugin
```

然后确认 profile `package.json` 的 `dsh.profile.bundles` 里有 `@local/dsh-context-guard`。

**改 Host 侧（`index.js`、`lib/core.js`）要完全重启 DSH 应用才生效**；只改客户端（`lib/client.js`）刷新一次页面即可。

装到其他 profile 同理，把 `desktop` 换成目标 profile 名。

## 命令

在任意对话里输入：

| 命令 | 作用 |
| --- | --- |
| `/guard check` | 立即做一次三项行为自检，**完成后直接返回完整状态**（判定 + 建议 + 报告 + 理由 + 证据），不需要再跑 `/guard status` |
| `/guard` 或 `/guard status` | 只读当前状态：判定、压缩记录、自检状态、文件/约束证据（不发起自检） |
| `/guard prompt` | 只打印自检提示词，不发送 |
| `/guard green` / `yellow` / `red` `[原因]` | 人工记录判定；会覆盖模型的自动核对结果，并给模型注入一条简短的行为约束 |
| `/guard pin <约束正文>` | 固定一条不可动约束；之后每次自检和交接单都会拿它核对 |
| `/guard unpin <序号|all>` | 删除固定约束 |
| `/guard handoff` | 生成 `交接单` 文件，并输出可直接粘贴到新对话的开场白 |
| `/guard show` | 恢复被 `×` 隐藏的哨兵条（后台自检从未停止） |
| `/guard reset` | 清空当前自检/判定/压缩记录；保留固定约束和文件记录 |

### 典型流程

1. 手动 `/guard check`，或在压缩后由插件自动跑到后台（fork 子代理）；对话里不会出现 A/B/C。
2. `check` 的结果本身就是完整状态：判定 🟢/🟡/🔴 + 建议 + 报告 + 理由 + 证据计数；自动触发时只写回精简判定。
3. 如果是 🟡：只做当前子目标，用 `/guard pin` 补上关键约束，做完就停。
4. 如果是 🔴：运行 `/guard handoff`，把生成的交接单和新对话开场白带走。

## 底部 Dock

客户端在输入框上方增加一条很窄的「交接哨兵」栏，只在有压缩/自检/判定时出现：

- 状态点 + 标题 + 当前判定/自检状态；
- `自检` = 复制 `/guard check`
- `交接单` = 复制 `/guard handoff`
- `状态` = 复制 `/guard status`
- `详情` 展开：固定约束、证据核对（漏报/未记录/约束命中）、报告内容、下一步/验证命令、原生写入文件。
- `×` 关闭哨兵条：**完全隐藏，不留小圆条、不占位**；后台自检照常运行，`/guard check` 仍可用。输入 `/guard show` 随时恢复（隐藏状态记在浏览器 localStorage，刷新后保持）。

按钮只复制命令，不会自动发消息；你可以先改一下再发。

## 配置

`desktop` profile 的 `cordis.patch.yml` 已经写入默认配置，可直接改：

```yaml
- id: dsh-context-guard
  name: '@local/dsh-context-guard'
  config:
    enabled: true
    autoProbe: true       # 压缩后自动做一次自检；false = 只提醒，手动 /guard check
    backgroundProbe: true # 自检在 fork 子代理里跑，A/B/C 不进对话，只回判定
    probeProvider: fork   # 'fork' 继承本对话已完成轮次（记忆测试）；'spawn' 是新对话，不测记忆
    probeTimeoutMs: 120000 # 单次后台自检的硬超时
    probeDelayMs: 1200    # 压缩结束后稍等再排入，避免和压缩收尾抢同一时刻
    cooldownMs: 600000    # 10 分钟内不重复自动运行，避免自检自身再触发压缩时循环
    rootsOnly: true       # 只测主对话，不测每个子代理
    injectAdvice: true    # /guard green|yellow|red 后给模型注入一条简短行为约束
    handoffDir: '.dsh-handoff'  # 交接单写在会话 cwd 下
```

### 后台自检（`backgroundProbe`）

默认 `true`：`/guard check` 或压缩后的自动自检都会在 **fork 子代理**里完成——子代理继承本对话的已完成轮次，所以测的还是同一份工作记忆，但它在自己的会话里回答，A/B/C 不进入你的对话。完成后插件只把判定（🟢/🟡/🔴 + 理由 + 证据计数）写回对话和哨兵条。

- 后端不可用、子代理超时、或回答里没有可解析的 `DSH_GUARD_JSON` 时，本次自检直接失败、**不会**退化成在对话里刷 A/B/C；把 `backgroundProbe` 设为 `false` 可以回到旧的可见问答模式。
- 子代理的回答只用于解析判定，正文不外泄、不写入交接单。
- 每次后台自检会多花一次子代理的模型调用，且不再占用主对话的上下文。

## 判定逻辑（证据核对）

**判定与上下文占用率、压缩次数无关**——那些只决定「什么时候测」，从不参与打分。打分规则是「模型自评打底，证据只在硬矛盾时覆盖」：

模型自评的 `green/yellow/red` 是基线。证据核对只在下面这些**硬矛盾**上升级判定：

- **约束**：用 `/guard pin` 固定过约束，但一条都没复述 → 🔴；只复述一部分 → 至少 🟡。
- **记不清**：`unknowns` 里承认记不清约束/规则 → 🔴。
- **文件大面积漏报**：本会话实际写入 ≥3 个文件但报告一个没列 → 🟡；漏报超过一半（且 ≥2 个）→ 🟡。
- **疑似编造**：报告里 ≥3 个文件不在原生写入记录里、并且占报告文件数一半以上 → 🟡。
- **下一步缺失**：没有下一步、没有验证命令、或验证命令明显不可执行 → 🟡。

以下情况**只作为提示，不降级**（旧版本会把它们全部算成 🟡，导致健康对话被误判）：

- 少量文件漏报（辅助脚本、临时文件没列全）；
- shell 写入的文件（会话日志、备份、生成物）不在原生 `write/edit` 记录里；
- 模型诚实列出的不确定项；
- 文件修改原因写得短；
- 没有固定约束时报告写「无」。

真正确认编造后，用 `/guard red` 人工覆盖；人工判定优先于自动核对。新的一次压缩会让旧判定过期。

> 这套规则的取向是：**证据用来抓硬伤，不用来挑刺**。一次 29% 占用、从未压缩、模型自评 🟢 的健康对话，不应该因为「漏列了几个修复脚本」被判黄。

## 与 dsh-context 的关系

**它是独立插件，不是 `dsh-context` 的扩展或依赖。**

- 不 import、不修改、不调用 dsh-context 的内部实现；卸载 dsh-context 后本插件仍然工作。
- 两者可以同时安装：dsh-context 的 Context / Fleet / `/context` 继续用来看结构、压缩事件、文件活动、命令执行。
- 本插件只在自己的 `contextGuard` projection 里记录：压缩、自检、判定、固定约束、原生写入文件、模型/窗口。它不复制 dsh-context 的仪表盘。
- 结构信号（占用率、压缩回收量、文件活动）适合用来决定「要不要提前测一次」，不适合直接决定「是否交接」。交接必须过行为测试。
- 如果你要的是技术上和 dsh-context 联动的版本（读它的 projection 显示结构、按占用率触发自检），那是另一种“软伴生”设计；当前版本刻意保持独立，避免跟它的版本升级耦合。

## 成本与隐私

- 不发起网络请求，不读取模型凭据。
- 每次自检会额外消耗**一次子代理**的模型调用（`backgroundProbe`），但不再占用主对话上下文；把它设为 `false` 则退回旧的「在对话里回答 A/B/C」模式，或把 `autoProbe` 设为 `false` 只用 `/guard check` 手动触发。
- 交接单写在本地 `<session cwd>/.dsh-handoff/`，不会上传。
- 插件只读取本会话的 session log projection、token meter、agent 接口；不读其他会话内容。

## 已知限制

- **shell 写入不在原生文件工具记录里**：用 `pwsh` / `bash` 的 `Set-Content`、重定向等方式写的文件不会被记入「实际写入」清单。报告里出现这类文件时插件只在理由里提示「不在原生写入记录、多为 shell 写入」，不降级；交接单会标「磁盘上不存在」帮助抽检。
- **模型可能不按格式回答**：没有 `DSH_GUARD_JSON` 时后台自检会明确失败，不会退回在对话里刷 A/B/C；可以重试或人工 `/guard green|yellow|red`。
- **后台自检的提示词只进子代理**：fork 子代理持有自己的会话，主对话只收到判定。`backgroundProbe: false` 的旧模式才会把自检题排进主对话。
- **自动自检只针对主对话**：`rootsOnly: true` 时子代理的压缩不会触发；需要时对子代理单独 `/guard check`。

## 验证

1. 任意会话运行 `/guard status`，应看到「上下文交接哨兵」。
2. 运行 `/guard pin 不要修改 dsh-context 包`，再 `/guard status`，应看到固定约束 1 条。
3. 运行 `/guard check`，应直接返回完整状态（判定 + 建议 + 报告 + 证据），对话里不出现 A/B/C。
4. 运行 `/guard handoff`，应在会话 cwd 下生成 `.dsh-handoff/<sessionId>-<timestamp>.md`。
5. 点哨兵条的 `×`，整条消失且不占位；输入 `/guard show` 恢复。

Host 侧的 projection 会以 `contextGuard` 键写入 `session_projcache`；可以用它确认插件已经加载并折叠了当前会话。

## 测试

```sh
node test/core.test.mjs      # 20 项：压缩触发、probe 识别、报告解析、证据核对、后台判定折叠、命令语法、交接单、dock epoch
node test/host.test.mjs      # 6 项：host 接线、后台 fork 自检、check=status、inject 守卫回归
node test/client.test.mjs    # 1 项：client bundle 加载并注册输入框上方 Dock
node test/scenario-report.mjs # 可读的效果回放
```

> 本机 `node` 不在 PATH；用 DSH 自带运行时执行：
> `C:\Users\21243\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe test/core.test.mjs`

## 版本兼容与维护

插件只依赖公开的 harness 接口（commands / sessionProjections / agents /
subagents / session events / client slots）。**DSH 升级后的核对清单、每个接口的
断裂症状、以及什么时候该升 `STATE_VERSION`，都在仓库的
[`docs/upgrading-dsh.md`](../docs/upgrading-dsh.md)。**

一句话版：升级后先跑上面三条测试 → 完全重启 → `/guard check` 冒烟 → 把
`engines.dsh` 和兼容表更新到实测过的版本。

## 排障

- **`/guard` 找不到**：Host 侧代码在应用启动时加载，**必须完全重启 DSH**；只刷新页面不够。
- **Dock 没出现**：Dock 只在会话里发生过压缩、自检或判定后出现；新会话空白时故意不占位置。先 `/guard status` 或 `/guard check`。
- **自动自检太吵**：把 `autoProbe` 改成 `false`，只保留 `/guard` 手动触发。
- **模型没按要求输出 JSON**：Dock 会显示「已回答，待人工判定」，直接用 `/guard green|yellow|red` 记录你的判断即可；插件不会替你猜。
- **想撤销判定**：`/guard reset` 清空自检/判定，再用 `/guard check` 重测。

## 卸载

在插件页移除 `@local/dsh-context-guard`，或：

```sh
dsh plugin --profile desktop remove @local/dsh-context-guard
```

再从 profile `package.json` 的 `dsh.profile.bundles` 里删掉 `@local/dsh-context-guard`，并从 profile `cordis.patch.yml` 里删掉 `id: dsh-context-guard` 的配置覆盖。插件目录（仓库里的 `dsh-plugin/`）可一并删除；已生成的 `.dsh-handoff/` 文件不会自动删除。
