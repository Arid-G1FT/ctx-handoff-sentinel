import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { PROBE_MARKER, PROBE_SOURCE, REPORT_FIELD, initialGuardState } from '../lib/core.js'

function createHarness(cwd, options = {}) {
  const state = initialGuardState({ cwd })
  const projection = { definition: null }
  const commands = new Map()
  const eventHandlers = []
  const cleanups = []
  const followups = []
  const injections = []
  const session = {
    id: 'session-test',
    header: { id: 'session-test', cwd, delegationDepth: 0 },
  }
  const agent = {
    id: 'session-test',
    session,
    followup(input) {
      followups.push(input)
    },
    inject(input) {
      injections.push(input)
    },
  }
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    sessionProjections: {
      register(definition) {
        projection.definition = definition
        return () => {}
      },
      stateOf(_session, key) {
        return key === 'contextGuard' ? state : undefined
      },
    },
    commands: {
      register(definition) {
        commands.set(definition.name, definition)
        return () => {}
      },
    },
    on(name, handler) {
      eventHandlers.push({ name, handler })
      return () => {}
    },
    agents: {
      get(id) {
        return id === session.id ? agent : undefined
      },
      roots() {
        return [agent]
      },
    },
    get(name) {
      return options.services?.[name]
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return () => {}
    },
  }
  const feed = (event) => {
    projection.definition.apply = projection.definition.apply.bind(projection.definition)
    Object.assign(state, projection.definition.apply(state, event))
    for (const entry of eventHandlers) entry.handler(session, event)
  }
  return { state, projection, commands, followups, injections, session, agent, ctx, feed, cleanups }
}

function summary(seq, id = 'comp-1') {
  return {
    type: 'compaction/summary',
    seq,
    time: seq * 1000,
    data: { compactionId: id, shadowedTokenCount: 9000, shadowedSeqs: [1, 2, 3], provider: 'deepseek', model: 'deepseek-flash' },
  }
}
function end(seq, id = 'comp-1') {
  return { type: 'compaction/end', seq, time: seq * 1000, data: { compactionId: id, turn: 1 } }
}

test('host wires the projection, command, and legacy in-conversation probe', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'guard-host-'))
  const harness = createHarness(cwd)
  apply(harness.ctx, {
    enabled: true,
    autoProbe: true,
    // Explicit opt-in to the legacy visible probe: without a subagents service
    // the background mode reports an error instead of dumping A/B/C in chat.
    backgroundProbe: false,
    probeDelayMs: 0,
    cooldownMs: 0,
    rootsOnly: true,
    injectAdvice: true,
    handoffDir: '.dsh-handoff',
  })
  assert.ok(harness.projection.definition !== null)
  assert.ok(harness.commands.has('guard'))

  harness.feed(summary(10))
  harness.feed(end(11))
  assert.equal(harness.state.probe.status, 'due')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(harness.followups.length, 1)
  assert.ok(harness.followups[0].content[0].text.includes(PROBE_MARKER))
  assert.equal(harness.followups[0].source.kind, PROBE_SOURCE)
  // Regression: the host splices inbox payloads into the request verbatim and
  // only assigns an identity, never a role. A bare { content, source } payload
  // reached the provider without `role` and every request failed to
  // deserialize with `messages[n]: missing field role`.
  assert.equal(harness.followups[0].role, 'user')
  assert.equal(typeof harness.followups[0].id, 'string')
  assert.ok(harness.followups[0].id.length > 0)

  harness.feed({
    type: 'user/message',
    seq: 12,
    time: 12000,
    data: {
      role: 'user',
      content: [{ type: 'text', text: harness.followups[0].content[0].text }],
      source: { kind: PROBE_SOURCE },
    },
  })
  assert.equal(harness.state.probe.status, 'queued')

  harness.feed({
    type: 'assistant/message',
    seq: 13,
    time: 13000,
    data: {
      message: {
        content: [
          { type: 'text', text: 'A. 约束...\nB. 文件...\nC. 下一步...' },
          {
            type: 'text',
            text: 'DSH_GUARD_JSON: ' + JSON.stringify({
              verdict: 'yellow',
              constraints: [{ text: '不要改动 dsh-context 包', source: 'user', certain: true }],
              files: [{ path: 'src/a.js', change: '改了一处', reason: '修复空值', certain: true }],
              nextStep: '运行测试',
              verify: ['npm test'],
              unknowns: [],
              spotCheckFile: 'src/a.js',
            }),
          },
        ],
      },
    },
  })
  harness.feed({ type: 'turn/end', seq: 14, time: 14000, data: { turn: 1 } })
  assert.equal(harness.state.probe.status, 'answered')
  assert.ok(harness.state.report !== null)
  assert.equal(harness.state.report.assessment.level, 'yellow')

  const status = await harness.commands.get('guard').handler({ agent: harness.agent, rawInput: 'status' })
  assert.equal(status.kind, 'success')
  assert.match(status.text, /上下文交接哨兵/)

  const pin = await harness.commands.get('guard').handler({ agent: harness.agent, rawInput: 'pin 不要改动 dsh-context 包' })
  assert.equal(pin.kind, 'success')
  harness.feed({ type: 'command/run', seq: 15, time: 15000, data: { commandId: 'cmd-1', name: 'guard', args: 'pin 不要改动 dsh-context 包', source: { kind: 'user' } } })
  harness.feed({ type: 'command/done', seq: 16, time: 16000, data: { commandId: 'cmd-1', kind: 'success', text: 'ok' } })
  assert.equal(harness.state.pins.length, 1)

  const red = await harness.commands.get('guard').handler({ agent: harness.agent, rawInput: 'red 约束快丢了' })
  assert.equal(red.kind, 'success')
  assert.equal(harness.injections.length, 1)
  assert.ok(harness.injections[0].content[0].text.includes('上下文交接哨兵'))

  const handoff = await harness.commands.get('guard').handler({ agent: harness.agent, rawInput: 'handoff' })
  assert.equal(handoff.kind, 'success')
  assert.match(handoff.text, /上下文交接单/)
  const fileMatch = /交接单已写入：\n(.+\.md)/.exec(handoff.text)
  assert.ok(fileMatch !== null)
  const content = await readFile(fileMatch[1], 'utf8')
  assert.match(content, /不要改动 dsh-context 包/)
  assert.match(content, /新对话开场白/)

  for (const cleanup of harness.cleanups) cleanup()
})

test('/guard check never reads the subagents property (cordis inject guard)', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'guard-inject-'))
  const activations = []
  const harness = createHarness(cwd, { services: forkServices(activations) })
  // Cordis throws on property access for services that are not declared in
  // `inject`. The plugin must resolve subagents through ctx.get() instead.
  Object.defineProperty(harness.ctx, 'subagents', {
    configurable: true,
    get() {
      throw new Error('cannot get property "subagents" without inject')
    },
  })
  apply(harness.ctx, {
    enabled: true,
    autoProbe: false,
    probeDelayMs: 0,
    cooldownMs: 0,
    rootsOnly: true,
    injectAdvice: true,
    handoffDir: '.dsh-handoff',
  })

  const result = await harness.commands.get('guard').handler({ agent: harness.agent, rawInput: 'check' })
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /判定：GREEN/)
  assert.equal(activations.length, 1)
  for (const cleanup of harness.cleanups) cleanup()
})

test('background mode reports an error instead of dumping A/B/C when subagents is missing', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'guard-nosub-'))
  const harness = createHarness(cwd)
  apply(harness.ctx, {
    enabled: true,
    autoProbe: false,
    probeDelayMs: 0,
    cooldownMs: 0,
    rootsOnly: true,
    injectAdvice: true,
    handoffDir: '.dsh-handoff',
  })

  const result = await harness.commands.get('guard').handler({ agent: harness.agent, rawInput: 'check' })
  assert.equal(result.kind, 'error')
  assert.match(result.text, /subagents/)
  assert.equal(harness.followups.length, 0, 'no visible probe may be queued in background mode')
  for (const cleanup of harness.cleanups) cleanup()
})

test('disabled config does not register anything', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'guard-host-off-'))
  const harness = createHarness(cwd)
  apply(harness.ctx, { enabled: false })
  assert.equal(harness.projection.definition, null)
  assert.equal(harness.commands.size, 0)
  assert.equal(harness.followups.length, 0)
})

function verdictOutput(verdict) {
  return {
    stopReason: 'completed',
    output: [{
      type: 'text',
      text: [
        'A. 约束：不要改动 dsh-context 包',
        'B. 文件：没有改动',
        'C. 下一步：继续',
        'DSH_GUARD_JSON: ' + JSON.stringify({
          verdict,
          constraints: [{ text: '不要改动 dsh-context 包', source: 'user', certain: true }],
          files: [],
          nextStep: '继续',
          verify: ['node --test'],
          unknowns: [],
          spotCheckFile: '',
        }),
      ].join('\n\n'),
    }],
  }
}

function forkServices(activations, verdict = 'green') {
  return {
    subagents: {
      async startActivation(spec) {
        activations.push(spec)
        return {
          childId: 'child-test',
          result: Promise.resolve(verdictOutput(verdict)),
          dispose: async () => {},
        }
      },
    },
  }
}

test('background probe runs in a fork child and folds only the verdict', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'guard-fork-'))
  const activations = []
  const harness = createHarness(cwd, { services: forkServices(activations) })
  apply(harness.ctx, {
    enabled: true,
    autoProbe: true,
    probeDelayMs: 0,
    cooldownMs: 0,
    rootsOnly: true,
    injectAdvice: true,
    handoffDir: '.dsh-handoff',
  })

  harness.feed(summary(10))
  harness.feed(end(11))
  await new Promise((resolve) => setTimeout(resolve, 40))

  assert.equal(activations.length, 1)
  assert.equal(activations[0].provider, 'fork')
  assert.equal(activations[0].delivery, 'caller')
  assert.ok(activations[0].request.prompt[0].text.includes(PROBE_MARKER))
  assert.equal(harness.followups.length, 0, 'the probe must not be queued into the conversation')
  assert.equal(harness.injections.length, 1)

  const injected = harness.injections[0]
  assert.equal(injected.role, 'user')
  assert.equal(injected.source.kind, PROBE_SOURCE)
  assert.equal(typeof injected.source[REPORT_FIELD], 'string')
  assert.match(injected.content[0].text, /后台自检完成/)
  assert.ok(!injected.content[0].text.includes('DSH_GUARD_JSON'), 'the machine report stays out of the visible text')

  // Fold the injected verdict back the way the durable log would.
  harness.feed({
    type: 'user/message',
    seq: 12,
    time: 12000,
    data: { role: 'user', content: injected.content, source: injected.source },
  })
  assert.equal(harness.state.probe.status, 'answered')
  assert.ok(harness.state.report !== null)
  assert.equal(harness.state.report.verdict, 'green')
  assert.equal(harness.state.report.assessment.level, 'green')

  const status = await harness.commands.get('guard').handler({ agent: harness.agent, rawInput: 'status' })
  assert.match(status.text, /判定：GREEN/)
  for (const cleanup of harness.cleanups) cleanup()
})

test('/guard check reviews in the background and returns the full status', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'guard-check-'))
  const activations = []
  const harness = createHarness(cwd, { services: forkServices(activations, 'yellow') })
  apply(harness.ctx, {
    enabled: true,
    autoProbe: false,
    probeDelayMs: 0,
    cooldownMs: 0,
    rootsOnly: true,
    injectAdvice: true,
    handoffDir: '.dsh-handoff',
  })

  const result = await harness.commands.get('guard').handler({ agent: harness.agent, rawInput: 'check' })
  assert.equal(result.kind, 'success')
  // Check and status are merged: the check result is a full status report.
  assert.match(result.text, /上下文交接哨兵/)
  assert.match(result.text, /判定：YELLOW/)
  assert.match(result.text, /最近报告：评估 YELLOW/)
  assert.match(result.text, /自检状态：answered/)
  assert.ok(!result.text.includes('DSH_GUARD_JSON'))
  assert.ok(!result.text.includes('详情：/guard status'))
  assert.equal(activations.length, 1)
  assert.equal(harness.followups.length, 0)
  assert.equal(harness.injections.length, 1)

  // The injected verdict stays compact and no longer points at a status run.
  assert.ok(!harness.injections[0].content[0].text.includes('/guard status'))
  for (const cleanup of harness.cleanups) cleanup()
})
