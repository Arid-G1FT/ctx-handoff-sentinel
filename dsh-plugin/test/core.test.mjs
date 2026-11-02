import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROBE_MARKER,
  PROBE_SOURCE,
  REPORT_FIELD,
  applyGuardEvent,
  assessReport,
  buildHandoffMarkdown,
  buildProbePrompt,
  buildStatusText,
  buildVerdictNotice,
  buildView,
  effectiveVerdict,
  initialGuardState,
  parseGuardCommand,
  parseReport,
  textFromOutput,
  writeFromToolCall,
} from '../lib/core.js'

const cwd = 'C:\\work\\demo'

function baseState() {
  return initialGuardState({ cwd })
}

function event(type, data, seq, time = seq * 1000) {
  return { type, data, seq, time }
}

function compact(state, seq = 10, tokens = 12000) {
  let next = applyGuardEvent(state, event('request/context', { provider: 'deepseek', model: 'deepseek-flash', contextWindow: 131072 }, 1))
  next = applyGuardEvent(next, event('compaction/summary', {
    compactionId: 'c1',
    shadowedTokenCount: tokens,
    shadowedSeqs: [2, 3, 4],
    provider: 'deepseek',
    model: 'deepseek-flash',
  }, seq))
  next = applyGuardEvent(next, event('compaction/end', { compactionId: 'c1', turn: 1 }, seq + 1))
  return next
}

function report(overrides = {}) {
  return {
    verdict: 'green',
    constraints: [{ text: '不要改动 dsh-context 包', source: 'user', certain: true }],
    files: [{ path: 'src/a.js', change: '加了校验', reason: '防止空值', certain: true }],
    nextStep: '运行单测',
    verify: ['npm test'],
    unknowns: [],
    spotCheckFile: 'src/a.js',
    ...overrides,
  }
}

test('compaction makes a probe due but does not decide a verdict', () => {
  const state = compact(baseState())
  assert.equal(state.compactions, 1)
  assert.equal(state.probe.status, 'due')
  assert.equal(state.lastCompaction.shadowedTokens, 12000)
  assert.equal(effectiveVerdict(state), null)
})

test('a probe message is recognized only for the plugin source kind', () => {
  let state = compact(baseState())
  state = applyGuardEvent(state, event('user/message', {
    role: 'user',
    content: [{ type: 'text', text: buildProbePrompt('auto') }],
    source: { kind: PROBE_SOURCE },
  }, 12))
  assert.equal(state.probe.status, 'queued')
  assert.equal(state.probe.requestedBy, 'auto')
  const ignored = applyGuardEvent(state, event('user/message', {
    role: 'user',
    content: [{ type: 'text', text: 'ordinary user message' }],
    source: { kind: 'user' },
  }, 13))
  assert.equal(ignored.probe.status, 'skipped')
})

test('turn end parses the JSON report and assesses it', () => {
  let state = compact(baseState())
  state = applyGuardEvent(state, event('tool/call', {
    callId: 'call-1',
    name: 'edit',
    arguments: JSON.stringify({ path: 'src/a.js', old_string: 'a', new_string: 'b' }),
  }, 12))
  state = applyGuardEvent(state, event('tool/result', {
    message: {
      role: 'tool',
      toolCallId: 'call-1',
      source: { kind: 'tool', callId: 'call-1' },
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
    },
  }, 13))
  state = applyGuardEvent(state, event('user/message', {
    role: 'user',
    content: [{ type: 'text', text: buildProbePrompt('auto') }],
    source: { kind: PROBE_SOURCE },
  }, 14))
  state = applyGuardEvent(state, event('assistant/message', {
    message: {
      content: [
        { type: 'text', text: 'A. 约束...\nB. 文件...\nC. 下一步...' },
        { type: 'text', text: 'DSH_GUARD_JSON: ' + JSON.stringify(report()) },
      ],
    },
  }, 15))
  assert.equal(state.probe.status, 'queued')
  state = applyGuardEvent(state, event('turn/end', { turn: 1 }, 16))
  assert.equal(state.probe.status, 'answered')
  assert.ok(state.report !== null)
  assert.equal(state.report.assessment.level, 'green')
  assert.equal(state.report.forCompactionSeq, 11)
  assert.equal(effectiveVerdict(state).level, 'green')
})

test('a missing file downgrades to yellow, a phantom file is flagged', () => {
  const state = compact(baseState())
  state.files = [
    { path: 'src/a.js', abs: 'C:\\work\\demo\\src\\a.js', writes: 2, added: 3, removed: 1, lastAt: 1 },
    { path: 'src/b.js', abs: 'C:\\work\\demo\\src\\b.js', writes: 1, added: 2, removed: 0, lastAt: 2 },
  ]
  const result = assessReport(state, {
    verdict: 'yellow',
    constraints: [{ text: '不要改动 dsh-context 包', source: 'user', certain: true }],
    files: [
      { path: 'src/a.js', change: '加校验', reason: '防空值', certain: true },
      { path: 'src/ghost.js', change: '新建', reason: '测试', certain: true },
    ],
    nextStep: '跑测试',
    verify: ['npm test'],
    unknowns: [],
    spotCheckFile: '',
    at: 10,
  })
  assert.equal(result.level, 'yellow')
  assert.equal(result.counts.missing, 1)
  assert.equal(result.counts.phantom, 1)
})

test('pinned constraints that are not recited force red', () => {
  let state = compact(baseState())
  state = applyGuardEvent(state, event('command/run', { commandId: 'cmd-1', name: 'guard', args: 'pin 不要改动 dsh-context 包', source: { kind: 'user' } }, 20))
  state = applyGuardEvent(state, event('command/done', { commandId: 'cmd-1', kind: 'success', text: 'ok' }, 21))
  assert.equal(state.pins.length, 1)
  const result = assessReport(state, {
    verdict: 'green',
    constraints: [{ text: '尽量写测试', source: 'user', certain: true }],
    files: [],
    nextStep: '继续',
    verify: ['npm test'],
    unknowns: [],
    at: 22,
  })
  assert.equal(result.level, 'red')
  assert.equal(result.checks.constraints, 'fail')
})

test('manual verdict wins and survives', () => {
  let state = compact(baseState())
  state = applyGuardEvent(state, event('command/run', { commandId: 'cmd-2', name: 'guard', args: 'red 约束丢了三项', source: { kind: 'user' } }, 30))
  state = applyGuardEvent(state, event('command/done', { commandId: 'cmd-2', kind: 'success', text: '已记录' }, 31))
  assert.equal(state.userVerdict.level, 'red')
  assert.equal(state.probe.status, 'answered')
  assert.equal(effectiveVerdict(state).level, 'red')
})

test('new compaction invalidates the old verdict', () => {
  let state = compact(baseState())
  state = applyGuardEvent(state, event('command/run', { commandId: 'cmd-3', name: 'guard', args: 'green', source: { kind: 'user' } }, 30))
  state = applyGuardEvent(state, event('command/done', { commandId: 'cmd-3', kind: 'success', text: 'ok' }, 31))
  assert.equal(effectiveVerdict(state).level, 'green')
  state = applyGuardEvent(state, event('compaction/summary', { compactionId: 'c2', shadowedTokenCount: 5000 }, 40))
  state = applyGuardEvent(state, event('compaction/end', { compactionId: 'c2', turn: 1 }, 41))
  assert.equal(state.probe.status, 'due')
  assert.equal(state.userVerdict, null)
  assert.equal(effectiveVerdict(state), null)
})

test('parseReport accepts marker and fenced forms', () => {
  const marker = parseReport('text\nDSH_GUARD_JSON: ' + JSON.stringify(report()), 1, 2, 3)
  assert.ok(marker !== null)
  assert.equal(marker.verdict, 'green')
  const fenced = parseReport('```json\n' + JSON.stringify(report({ verdict: 'yellow' })) + '\n```', 1, 2, 3)
  assert.ok(fenced !== null)
  assert.equal(fenced.verdict, 'yellow')
  assert.equal(parseReport('no json here', 1, 2, 3), null)
})

test('write footprint extracts write/edit/str_replace_editor', () => {
  assert.deepEqual(
    { path: 'src/a.js', added: 2, removed: 0 },
    (() => {
      const result = writeFromToolCall('write', JSON.stringify({ path: 'src/a.js', content: 'a\nb' }), cwd)
      return { path: result.path, added: result.added, removed: result.removed }
    })(),
  )
  const edit = writeFromToolCall('edit', JSON.stringify({ path: 'src/a.js', old_string: 'a', new_string: 'b\nc' }), cwd)
  assert.equal(edit.added, 2)
  assert.equal(edit.removed, 1)
  const str = writeFromToolCall('str_replace_editor', JSON.stringify({ command: 'str_replace', path: 'src/a.js', old_str: 'x', new_str: 'y' }), cwd)
  assert.equal(str.added, 1)
})

test('handoff markdown contains constraints, files, next step and opener', () => {
  let state = compact(baseState())
  state.pins = [{ text: '不要改动 dsh-context 包', at: 1, seq: 1 }]
  state.report = {
    verdict: 'red',
    constraints: [{ text: '不要改动 dsh-context 包', source: 'user', certain: true }],
    files: [{ path: 'src/a.js', change: '加校验', reason: '防空值', certain: true }],
    nextStep: '运行单测',
    verify: ['npm test'],
    unknowns: [],
    spotCheckFile: 'src/a.js',
    at: 2,
    seq: 2,
    forCompactionSeq: state.lastCompaction.seq,
    assessment: { level: 'red', reasons: ['测试'], checks: {}, counts: {}, comparedAt: 2 },
  }
  const markdown = buildHandoffMarkdown({ state, sessionId: 'session-1' })
  assert.match(markdown, /上下文交接单/)
  assert.match(markdown, /不要改动 dsh-context 包/)
  assert.match(markdown, /src\/a\.js/)
  assert.match(markdown, /npm test/)
  assert.match(markdown, /新对话开场白/)
})

test('probe prompt carries the marker and the JSON contract but no answers', () => {
  const prompt = buildProbePrompt('auto')
  assert.ok(prompt.includes(PROBE_MARKER))
  assert.ok(prompt.includes('DSH_GUARD_JSON'))
  assert.ok(prompt.includes('绿色') === false)
  assert.ok(prompt.includes('本会话刚刚完成一次上下文压缩'))
})

test('guard command grammar', () => {
  assert.deepEqual(parseGuardCommand(''), { verb: 'status', text: '' })
  assert.deepEqual(parseGuardCommand('check'), { verb: 'check', text: '' })
  assert.deepEqual(parseGuardCommand('red 约束丢了'), { verb: 'verdict', level: 'red', reason: '约束丢了' })
  assert.deepEqual(parseGuardCommand('pin 不要改配置'), { verb: 'pin', text: '不要改配置' })
  assert.deepEqual(parseGuardCommand('bogus'), { verb: 'unknown', text: 'bogus' })
})

test('view is stable for unchanged state', () => {
  const state = compact(baseState())
  const first = buildView(state)
  const second = buildView(state)
  assert.notEqual(first, second) // buildView returns a fresh object; the plugin caches it by state
  assert.equal(first.headline, second.headline)
  assert.equal(first.v, 6)
})

test('status text is readable', () => {
  const state = compact(baseState())
  const text = buildStatusText(state)
  assert.match(text, /上下文交接哨兵/)
  assert.match(text, /自检状态/)
  assert.match(text, /\/guard check/)
})

// The real-world report that used to grade yellow in a healthy 29% context
// conversation: 12 files written, 5 helper files omitted, 3 shell-written paths
// flagged as "phantom", 2 honest unknowns, model self-reported green.
test('bookkeeping noise does not demote a green self-report', () => {
  const state = compact(baseState())
  state.files = Array.from({ length: 12 }, (_, i) => ({
    path: `src/f${i}.js`,
    abs: `C:\\work\\demo\\src\\f${i}.js`,
    writes: 1,
    added: 1,
    removed: 0,
    lastAt: i,
  }))
  const report = {
    verdict: 'green',
    constraints: [{ text: '不要改动 dsh-context 包', source: 'user', certain: true }],
    files: [
      { path: 'src/f0.js', change: '改', reason: '修复空值', certain: true },
      { path: 'src/f1.js', change: '改', reason: '修复空值', certain: true },
      { path: 'src/f2.js', change: '改', reason: '修复空值', certain: true },
      { path: 'src/f3.js', change: '改', reason: '修复空值', certain: true },
      { path: 'src/f4.js', change: '改', reason: '修复空值', certain: true },
      { path: 'src/f5.js', change: '改', reason: '修复空值', certain: true },
      { path: 'src/f6.js', change: '改', reason: '修复空值', certain: true },
      { path: 'C:\\\\Users\\\\me\\\\.dsh\\\\sessions\\\\a\\\\session.v4.jsonl.zstd', change: '修复', reason: '会话修复', certain: true },
      { path: 'backup.zstd', change: '备份', reason: '回滚保险', certain: true },
      { path: '.dsh-repair/patch.mjs', change: '脚本', reason: '修复工具', certain: true },
    ],
    nextStep: '继续',
    verify: ['node --test test/core.test.mjs'],
    unknowns: ['原对话在列表里的位置', 'handoff 尚未验证'],
    spotCheckFile: '',
    at: 10,
  }
  const result = assessReport(state, report)
  assert.equal(result.level, 'green')
  assert.equal(result.counts.missing, 5)
  assert.equal(result.counts.phantom, 3)
  assert.ok(result.reasons.some((reason) => reason.includes('不降级')))
})

test('major omissions and evidence-free reports still demote', () => {
  const state = compact(baseState())
  state.files = Array.from({ length: 6 }, (_, i) => ({
    path: `src/f${i}.js`,
    abs: `C:\\work\\demo\\src\\f${i}.js`,
    writes: 1,
    added: 1,
    removed: 0,
    lastAt: i,
  }))
  const result = assessReport(state, {
    verdict: 'green',
    constraints: [{ text: '不要改动 dsh-context 包', source: 'user', certain: true }],
    files: [{ path: 'src/f0.js', change: '改', reason: '修复空值', certain: true }],
    nextStep: '继续',
    verify: ['npm test'],
    unknowns: [],
    at: 10,
  })
  assert.equal(result.level, 'yellow')
  assert.match(result.reasons.join('\n'), /漏报/)
})

// The real-world case that motivated the critical tier: a long kimi session
// wrote 64 files, the self-check listed 5 (92% omitted) and still called itself
// green. The user saw obvious degradation while the sentinel said yellow.
test('losing almost all file memory is red, not yellow', () => {
  const state = compact(baseState())
  state.files = Array.from({ length: 64 }, (_, i) => ({
    path: `outputs/Kimi_DeepSeek_20261101/F${i}.md`,
    abs: `C:\\work\\demo\\outputs\\Kimi_DeepSeek_20261101\\F${i}.md`,
    writes: 1,
    added: 1,
    removed: 0,
    lastAt: i,
  }))
  const result = assessReport(state, {
    verdict: 'green',
    constraints: [{ text: '不要改动 dsh-context 包', source: 'user', certain: true }],
    files: [
      { path: 'outputs/Kimi_DeepSeek_20261101/F0.md', change: '交付', reason: '交接文档', certain: true },
      { path: 'outputs/Kimi_DeepSeek_20261101/F1.md', change: '交付', reason: '状态板', certain: true },
      { path: 'outputs/Kimi_DeepSeek_20261101/F2.md', change: '交付', reason: '验收记录', certain: true },
      { path: 'outputs/Kimi_DeepSeek_20261101/F3.md', change: '交付', reason: '验收记录', certain: true },
      { path: 'outputs/Kimi_DeepSeek_20261101/F4.md', change: '交付', reason: '验收记录', certain: true },
    ],
    nextStep: '继续下一个任务',
    verify: ['python -m unittest'],
    unknowns: ['a', 'b', 'c', 'd', 'e'],
    at: 10,
  })
  assert.equal(result.level, 'red')
  assert.equal(result.checks.files, 'fail')
  assert.equal(result.counts.missing, 59)
  assert.match(result.reasons.join('\n'), /文件记忆/)
  assert.match(result.reasons.join('\n'), /模型自评 green/)
})

test('a report that lists no files at all is red once >=10 files were written', () => {
  const state = compact(baseState())
  state.files = Array.from({ length: 12 }, (_, i) => ({
    path: `src/f${i}.js`,
    abs: `C:\\work\\demo\\src\\f${i}.js`,
    writes: 1,
    added: 1,
    removed: 0,
    lastAt: i,
  }))
  const result = assessReport(state, {
    verdict: 'green',
    constraints: [{ text: '不要改配置', source: 'user', certain: true }],
    files: [],
    nextStep: '继续',
    verify: ['npm test'],
    unknowns: [],
    at: 10,
  })
  assert.equal(result.level, 'red')
  assert.match(result.reasons.join('\n'), /文件记忆已失效/)
})

test('/guard show bumps the dock epoch so a hidden dock can return', () => {
  let state = baseState()
  assert.equal(state.dockEpoch, 0)
  state = applyGuardEvent(state, event('command/run', { commandId: 'cmd-1', name: 'guard', args: 'show', source: { kind: 'user' } }, 30))
  state = applyGuardEvent(state, event('command/done', { commandId: 'cmd-1', kind: 'success', text: 'ok' }, 31))
  assert.equal(state.dockEpoch, 1)
  assert.equal(buildView(state).dockEpoch, 1)
})

test('report carries the optional handoff fields', () => {
  const report = parseReport(
    'DSH_GUARD_JSON: ' + JSON.stringify({
      verdict: 'green',
      objective: 'ship the parser',
      constraints: [],
      files: [],
      done: ['parser built and fuzzed'],
      verified: [{ command: 'npm test', result: '12 passed' }],
      decisions: [{ decision: 'use a queue', reason: 'API rate limits', rejected: false }],
      failedAttempts: ['polling hit 429'],
      nextStep: 'wire it into the CLI',
      verify: ['npm test'],
      unknowns: [],
    }),
    10,
    11,
    null,
  )
  assert.equal(report.objective, 'ship the parser')
  assert.deepEqual(report.done, ['parser built and fuzzed'])
  assert.equal(report.verified[0].result, '12 passed')
  assert.equal(report.decisions[0].decision, 'use a queue')
  assert.equal(report.failedAttempts[0], 'polling hit 429')
})

test('handoff markdown uses the seven-section framework', () => {
  const state = compact(baseState())
  state.report = parseReport(
    'DSH_GUARD_JSON: ' + JSON.stringify({
      verdict: 'yellow',
      objective: 'ship the parser',
      constraints: [{ text: 'do not touch the public API', source: 'user', certain: true }],
      files: [{ path: 'src/parser.js', change: 'added AST walker', reason: 'parser rewrite', certain: true }],
      done: ['parser built and fuzzed'],
      verified: [{ command: 'npm test', result: '12 passed' }],
      decisions: [
        { decision: 'use a queue', reason: 'API rate limits', rejected: false },
        { decision: 'rewrite with regexes', reason: 'unmaintainable', rejected: true },
      ],
      failedAttempts: ['polling hit 429'],
      nextStep: 'wire it into the CLI',
      verify: ['npm test'],
      unknowns: ['flag default'],
    }),
    10,
    11,
    null,
  )
  state.report.assessment = assessReport(state, state.report)
  const markdown = buildHandoffMarkdown({ state, sessionId: 'session-1' })
  for (const heading of [
    '## 1. 目标与完成标准',
    '## 2. 当前状态',
    '## 3. 关键决策与理由',
    '## 4. 涉及文件清单',
    '## 5. 已知坑与失败尝试',
    '## 6. 下一步',
    '## 7. 约束',
    '## 新对话开场白',
  ]) {
    assert.ok(markdown.includes(heading), `missing ${heading}`)
  }
  assert.match(markdown, /ship the parser/)
  assert.match(markdown, /use a queue/)
  assert.match(markdown, /rewrite with regexes/)
  assert.match(markdown, /polling hit 429/)
  assert.match(markdown, /12 passed/)
  assert.match(markdown, /do not touch the public API/)
})

test('activation output flattens to text', () => {
  assert.equal(textFromOutput('plain'), 'plain')
  assert.equal(textFromOutput([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(textFromOutput(undefined), '')
  assert.equal(textFromOutput([]), '')
})

test('background verdict notice carries no A/B/C dump and no machine JSON', () => {
  const state = baseState()
  const report = parseReport(
    'DSH_GUARD_JSON: ' + JSON.stringify({
      verdict: 'yellow',
      constraints: [{ text: '不要改配置', source: 'user', certain: true }],
      files: [],
      nextStep: '继续',
      verify: ['npm test'],
      unknowns: [],
      spotCheckFile: '',
    }),
    1000,
    5,
    null,
  )
  const assessment = assessReport(state, report)
  const notice = buildVerdictNotice(report, assessment)
  assert.equal(notice.level, assessment.level)
  assert.match(notice.text, /后台自检完成/)
  assert.ok(!notice.text.includes('DSH_GUARD_JSON'))
  assert.ok(!notice.text.includes('A.'))
  assert.ok(notice.summary.length > 0 && notice.summary.length <= 120)
})

test('background verdict folds from source[REPORT_FIELD] without an answer turn', () => {
  const report = {
    verdict: 'green',
    constraints: [{ text: '不要改配置', source: 'user', certain: true }],
    files: [],
    nextStep: '继续',
    verify: ['npm test'],
    unknowns: [],
    spotCheckFile: '',
  }
  const state = applyGuardEvent(
    baseState(),
    event('user/message', {
      role: 'user',
      content: [{ type: 'text', text: '交接哨兵 · 后台自检完成：🟢 GREEN' }],
      source: { kind: PROBE_SOURCE, [REPORT_FIELD]: JSON.stringify(report) },
    }, 7),
  )
  assert.equal(state.probe.status, 'answered')
  assert.ok(state.report !== null)
  assert.equal(state.report.verdict, 'green')
  assert.ok(state.report.assessment !== null)
  assert.equal(state.report.assessment.level, 'green')
  assert.equal(effectiveVerdict(state).level, 'green')
})

