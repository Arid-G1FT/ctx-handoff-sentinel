/**
 * Human-readable scenario report for dsh-context-guard.
 *
 * It feeds the same event stream the live session would produce (compaction,
 * probe prompt, model answer, turn end) and prints the verdict, evidence, and
 * handoff brief. This is a demonstration, not a unit test.
 *
 * Run: node test/scenario-report.mjs
 */

import {
  PROBE_SOURCE,
  applyGuardEvent,
  buildHandoffMarkdown,
  buildProbePrompt,
  buildStatusText,
  effectiveVerdict,
  initialGuardState,
} from '../lib/core.js'

const cwd = process.cwd()
const BASE_TIME = Date.now() - 60 * 60 * 1000

function event(type, data, seq, time = BASE_TIME + seq * 1000) {
  return { type, data, seq, time }
}

function base() {
  return initialGuardState({ cwd })
}

function addWrite(state, callId, path, seq) {
  let next = applyGuardEvent(
    state,
    event('tool/call', {
      callId,
      name: 'write',
      arguments: JSON.stringify({ path, content: 'a\nb\nc' }),
    }, seq),
  )
  next = applyGuardEvent(
    next,
    event('tool/result', {
      message: {
        role: 'tool',
        toolCallId: callId,
        source: { kind: 'tool', callId },
        isError: false,
        content: [{ type: 'text', text: 'ok' }],
      },
    }, seq + 1),
  )
  return next
}

function compact(state, seq, shadowedTokens) {
  let next = applyGuardEvent(
    state,
    event('request/context', { provider: 'deepseek', model: 'deepseek-flash', contextWindow: 131072 }, 1),
  )
  next = applyGuardEvent(
    next,
    event('compaction/summary', {
      compactionId: 'comp-1',
      shadowedTokenCount: shadowedTokens,
      shadowedSeqs: [2, 3, 4],
      provider: 'deepseek',
      model: 'deepseek-flash',
    }, seq),
  )
  return applyGuardEvent(next, event('compaction/end', { compactionId: 'comp-1', turn: 1 }, seq + 1))
}

function probe(state, seq) {
  return applyGuardEvent(
    state,
    event('user/message', {
      role: 'user',
      content: [{ type: 'text', text: buildProbePrompt('auto') }],
      source: { kind: PROBE_SOURCE },
    }, seq),
  )
}

function answer(state, seq, report) {
  const text = [
    'A. 约束：逐条列出。',
    'B. 文件：逐条列出改动和原因。',
    'C. 下一步与验证命令。',
    'DSH_GUARD_JSON: ' + JSON.stringify(report),
  ].join('\n')
  let next = applyGuardEvent(
    state,
    event('assistant/message', { message: { content: [{ type: 'text', text }] } }, seq),
  )
  next = applyGuardEvent(next, event('turn/end', { turn: 1 }, seq + 1))
  return next
}

function report(overrides = {}) {
  return {
    verdict: 'green',
    constraints: [
      { text: '不要修改 dsh-context 包', source: 'user', certain: true },
      { text: '验证命令必须能直接执行', source: 'user', certain: true },
    ],
    files: [
      { path: 'src/a.js', change: '增加空值校验', reason: '避免运行时崩', certain: true },
      { path: 'src/b.js', change: '补了错误分支', reason: '覆盖失败路径', certain: true },
    ],
    nextStep: '运行单测并检查 a/b 两个文件',
    verify: ['npm test'],
    unknowns: [],
    spotCheckFile: 'src/a.js',
    ...overrides,
  }
}

function scenario(label, build) {
  const state = build()
  const effective = effectiveVerdict(state)
  const reportState = state.report
  console.log(`\n### ${label}`)
  console.log('')
  console.log('| 项 | 值 |')
  console.log('| --- | --- |')
  console.log(`| 判定 | ${effective === null ? '无' : effective.level.toUpperCase()}（${effective?.source ?? '-'}） |`)
  if (reportState !== null && reportState.assessment !== null) {
    const counts = reportState.assessment.counts
    console.log(`| 证据 | 实际写入 ${counts.actualFiles}，报告列出 ${counts.reportedFiles}，漏报 ${counts.missing}，未记录 ${counts.phantom}，约束命中 ${counts.pinsMatched}/${counts.pins} |`)
    console.log(`| 原因 | ${reportState.assessment.reasons.join('；') || '无'} |`)
  }
  console.log(`| 建议 | ${effective === null ? '尚无' : effective.level === 'green' ? '🟢 可继续，可扩范围' : effective.level === 'yellow' ? '🟡 只做当前子目标，不扩范围' : '🔴 立即 /guard handoff'} |`)
  return state
}

console.log('# DSH Context Guard 效果测试')
console.log('')
console.log('> 这是同一套 session 事件流下的确定性回放；不调用模型，不需要压缩真实会话。')

// Scenario 1: green. Two real native writes, both reported with reasons.
let green = compact(base(), 10, 9000)
green = addWrite(green, 'call-a', 'src/a.js', 12)
green = addWrite(green, 'call-b', 'src/b.js', 14)
green = probe(green, 16)
green = answer(green, 17, report())
scenario('场景 1：三项齐全，文件/命令级 → 🟢', () => green)
console.log('')
console.log('```text')
console.log(buildStatusText(green).split('\n').slice(0, 8).join('\n'))
console.log('...')
console.log('```')

// Scenario 2: yellow. One real write is omitted and the reported reason is vague.
let yellow = compact(base(), 10, 9000)
yellow = addWrite(yellow, 'call-a', 'src/a.js', 12)
yellow = addWrite(yellow, 'call-b', 'src/b.js', 14)
yellow = probe(yellow, 16)
yellow = answer(yellow, 17, report({
  verdict: 'green',
  files: [{ path: 'src/a.js', change: '改了一点', reason: '', certain: true }],
}))
scenario('场景 2：约束对，但文件漏报/原因模糊 → 🟡', () => yellow)
console.log('')
console.log('```text')
console.log(buildStatusText(yellow).split('\n').slice(0, 8).join('\n'))
console.log('...')
console.log('```')

// Scenario 3: red. A pinned constraint is not recited and a file is invented.
let red = compact(base(), 10, 9000)
red = addWrite(red, 'call-a', 'src/a.js', 12)
red = applyGuardEvent(red, event('command/run', {
  commandId: 'cmd-pin',
  name: 'guard',
  args: 'pin 不要修改 dsh-context 包',
  source: { kind: 'user' },
}, 13))
red = applyGuardEvent(red, event('command/done', { commandId: 'cmd-pin', kind: 'success', text: 'ok' }, 14))
red = probe(red, 16)
red = answer(red, 17, report({
  verdict: 'green',
  constraints: [{ text: '尽量写测试', source: 'user', certain: true }],
  files: [
    { path: 'src/a.js', change: '加了校验', reason: '防空值', certain: true },
    { path: 'src/ghost.js', change: '新建文件', reason: '测试', certain: true },
  ],
  nextStep: '继续',
  verify: [],
}))
scenario('场景 3：固定约束未复述 + 编造文件 → 🔴', () => red)

const handoff = buildHandoffMarkdown({ state: red, sessionId: 'session-demo' })
console.log('')
console.log('### `/guard handoff` 生成的交接单（节选）')
console.log('')
console.log('```markdown')
console.log(handoff.split('\n').slice(0, 34).join('\n'))
console.log('...')
console.log('```')

console.log('')
console.log('## 自动触发链')
console.log('')
console.log('`compaction/end` → `agent.followup(三项自检提示)` → 模型回答 `DSH_GUARD_JSON` → `turn/end` 解析并核对 → `contextGuard` projection → `/guard status` / Dock / 交接单')
console.log('')
console.log('自检提示长度：', buildProbePrompt('auto').length, '字符；包含 marker：', buildProbePrompt('auto').includes('[[DSH-CONTEXT-GUARD:PROBE:'))
