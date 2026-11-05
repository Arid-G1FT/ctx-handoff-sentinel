/**
 * dsh-context-guard — host half.
 *
 * Works beside dsh-context: dsh-context tells you what the context is made of;
 * this plugin decides when the context can no longer prove itself, by running
 * the three behavioral tests after every compaction, and by making the handoff
 * cheap (`/guard handoff`).
 *
 * Design rule: the number of compactions is only a timestamp. The verdict is
 * always behavioral:
 *   A. can it recite the immovable constraints?
 *   B. can it list changed files with reasons, at file level?
 *   C. can it give the next step and a runnable verify command?
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import {
  ADVICE_MARKER,
  PROBE_MARKER,
  PROBE_SOURCE,
  REPORT_FIELD,
  adviceFor,
  applyGuardEvent,
  assessReport,
  buildAdviceMessage,
  buildHandoffInstruction,
  buildHandoffMarkdown,
  buildProbePrompt,
  buildStatusText,
  buildVerdictNotice,
  buildView,
  initialGuardState,
  parseGuardCommand,
  parseReport,
  stateSchema,
  textFromOutput,
  viewSchema,
} from './lib/core.js'

export const name = 'dsh-context-guard'
export const inject = ['commands', 'agents', 'sessionProjections']

const DEFAULTS = {
  enabled: true,
  autoProbe: true,
  probeDelayMs: 1200,
  cooldownMs: 10 * 60 * 1000,
  rootsOnly: true,
  injectAdvice: true,
  handoffDir: '.dsh-handoff',
  // Run the self-check in a fork child so the A/B/C answer never lands in the
  // user's conversation; only the verdict comes back.
  backgroundProbe: true,
  probeProvider: 'fork',
  probeTimeoutMs: 120_000,
  // Structural triggers decide *when* to test; they never grade the result.
  // Fire a background check when the next request would use this much of the
  // window, and/or every N steps. No compaction required.
  pressureProbe: true,
  pressureThreshold: 0.6,
  stepProbeInterval: 0,
}

const VIEW_CACHE = new WeakMap()

/** Client -> host endpoint used by the red-verdict handoff popup. */
const HANDOFF_ROUTE = '/api/dsh-context-guard/handoff'

/** Read a small JSON body from a Node request; returns null on malformed input. */
function readJsonBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    let bytes = 0
    request.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > 64 * 1024) return
      chunks.push(buffer)
    })
    request.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch {
        resolve(null)
      }
    })
    request.on('error', () => resolve(null))
  })
}

/** Same-origin check for the popup endpoint; non-browser callers (no Origin) pass. */
function isSameOriginRequest(request) {
  const origin = request.headers?.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  const host = request.headers?.host
  if (typeof host !== 'string' || host.length === 0) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function boolOption(value, fallback) {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}

function numberOption(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function normalizeOptions(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  return {
    enabled: boolOption(raw.enabled, DEFAULTS.enabled),
    autoProbe: boolOption(raw.autoProbe, DEFAULTS.autoProbe),
    probeDelayMs: numberOption(raw.probeDelayMs, DEFAULTS.probeDelayMs, 0, 60_000),
    cooldownMs: numberOption(raw.cooldownMs, DEFAULTS.cooldownMs, 0, 24 * 60 * 60 * 1000),
    rootsOnly: boolOption(raw.rootsOnly, DEFAULTS.rootsOnly),
    injectAdvice: boolOption(raw.injectAdvice, DEFAULTS.injectAdvice),
    handoffDir:
      typeof raw.handoffDir === 'string' && raw.handoffDir.trim().length > 0
        ? raw.handoffDir.trim()
        : DEFAULTS.handoffDir,
    backgroundProbe: boolOption(raw.backgroundProbe, DEFAULTS.backgroundProbe),
    probeProvider:
      typeof raw.probeProvider === 'string' && raw.probeProvider.trim().length > 0
        ? raw.probeProvider.trim()
        : DEFAULTS.probeProvider,
    probeTimeoutMs: numberOption(raw.probeTimeoutMs, DEFAULTS.probeTimeoutMs, 5_000, 10 * 60 * 1000),
    pressureProbe: boolOption(raw.pressureProbe, DEFAULTS.pressureProbe),
    pressureThreshold: numberOption(raw.pressureThreshold, DEFAULTS.pressureThreshold, 0.1, 0.95),
    stepProbeInterval: numberOption(raw.stepProbeInterval, DEFAULTS.stepProbeInterval, 0, 1000),
  }
}

function cacheView(state) {
  let view = VIEW_CACHE.get(state)
  if (view === undefined) {
    view = buildView(state)
    VIEW_CACHE.set(state, view)
  }
  return view
}

/**
 * Project one just-finished background verdict into a state snapshot that
 * `buildStatusText` can render.
 *
 * The durable projection only folds the injected verdict message on the next
 * step, so the command would otherwise report the previous state. This snapshot
 * lets `/guard check` return the full status immediately.
 */
function withFreshReport(state, outcome) {
  const now = Date.now()
  return {
    ...state,
    probe: {
      ...state.probe,
      status: 'answered',
      answerAt: now,
      answeredForCompactionSeq: state.lastCompaction?.seq ?? state.probe.forCompactionSeq,
      answerText: '',
    },
    report: { ...outcome.report, assessment: outcome.assessment },
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host plugin context
 * @param {object} config - row config from the bundle patch / profile patch
 */
export function apply(ctx, config) {
  const options = normalizeOptions(config)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('dsh-context-guard') : console
  if (!options.enabled) {
    logger.info('dsh-context-guard is disabled by config')
    return
  }

  const timers = new Map()
  const lastAutoAt = new Map()
  const stepCounts = new Map()
  const lastTotals = new Map()

  /** Read the guard projection state; never throw into a command or event handler. */
  const readState = (session) => {
    try {
      return ctx.sessionProjections.stateOf(session, 'contextGuard') ?? initialGuardState(session.header)
    } catch (error) {
      logger.warn(`dsh-context-guard: cannot read projection state: ${String(error)}`)
      return initialGuardState(session.header)
    }
  }

  /** Whether this session belongs to a runtime root agent (not a subagent). */
  const isRootSession = (session) => {
    if (!options.rootsOnly) return true
    try {
      const roots = ctx.agents.roots()
      if (Array.isArray(roots) && roots.length > 0) {
        return roots.some((agent) => agent?.id === session.id)
      }
    } catch {
      // fall through to the header heuristic
    }
    return (session.header?.delegationDepth ?? 0) === 0
  }

  /** Resolve the live agent for one session. */
  const agentOf = (session) => {
    try {
      return ctx.agents.get(session.id) ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * Build one host-shaped inbox message.
   *
   * The host splices `agent.followup()`/`agent.inject()` payloads into the
   * request as they are, and only assigns an identity — it does not infer a
   * role. A bare `{ content, source }` therefore reaches the provider with no
   * `role`, and the whole request fails to deserialize (`messages[n]: missing
   * field role`). Mirror `createUserMessage()` from `@deepseek-ai/dsh-llm`:
   * always carry a role and a stable id.
   */
  const createInboxMessage = (input) => ({
    ...input,
    role: 'user',
    id: randomUUID(),
  })

  /** Queue the three-test probe through the agent's ordinary next-turn inbox. */
  const queueProbe = (agent, reason) => {
    if (typeof agent?.followup !== 'function') {
      throw new Error('the live agent does not accept follow-up messages')
    }
    agent.followup(
      createInboxMessage({
        content: [{ type: 'text', text: buildProbePrompt(reason) }],
        source: { kind: PROBE_SOURCE },
      }),
    )
  }

  /** Resolve an optional host service without failing when it is absent. */
  const serviceOf = (serviceName) => {
    try {
      if (typeof ctx.get !== 'function') return undefined
      return ctx.get(serviceName, false) ?? undefined
    } catch {
      return undefined
    }
  }

  /** The subagent service, when this composition exposes fork/activation slots. */
  const subagentService = () => {
    // Never touch `ctx.subagents` as a property: cordis throws
    // `cannot get property "subagents" without inject` unless the service is
    // declared in `inject`, and declaring it would make the plugin refuse to
    // load at all in compositions without subagents. `ctx.get()` is the
    // declaration-free accessor (same one used for `tokenMeter`).
    const service = serviceOf('subagents')
    if (service === undefined || service === null) return undefined
    return typeof service.startActivation === 'function' ? service : undefined
  }

  /**
   * Run one self-check in a fork child instead of in this conversation.
   *
   * The child inherits the parent's completed turns, so it is measured on
   * exactly the same working memory, but it answers in its own session. Nothing
   * it writes reaches the user's transcript: only the verdict comes back.
   *
   * @returns {{report: object, assessment: object}|null} null when the backend
   * is unavailable, times out, or the child produced no parsable report.
   */
  const runBackgroundProbe = async (session, agent, reason) => {
    const subagents = subagentService()
    if (subagents === undefined) return null
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    const timer = setTimeout(() => {
      try {
        controller?.abort()
      } catch {
        // ignore
      }
    }, options.probeTimeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    let activation
    try {
      activation = await subagents.startActivation({
        provider: options.probeProvider,
        label: `context-guard-probe:${session.id}`,
        request: {
          prompt: [{ type: 'text', text: buildProbePrompt(reason) }],
          parent: agent,
        },
        delivery: 'caller',
        signal: controller?.signal,
      })
      const result = await activation.result
      const stopReason = result?.stopReason
      if (typeof stopReason === 'string' && stopReason !== 'completed') {
        logger.warn(`dsh-context-guard: background probe stopped with ${stopReason}`)
        return null
      }
      const answer = textFromOutput(result?.output)
      const state = readState(session)
      const report = parseReport(answer, Date.now(), 0, state.lastCompaction?.seq ?? null)
      if (report === null) {
        logger.warn('dsh-context-guard: background probe answered without a parsable report')
        return null
      }
      return { report, assessment: assessReport(state, report) }
    } finally {
      clearTimeout(timer)
      try {
        await activation?.dispose?.()
      } catch {
        // disposal is best effort; the activation already settled
      }
    }
  }

  /**
   * Fold one background verdict back into the session.
   *
   * `inject()` adds model-facing context without waking the driver, so the
   * verdict lands in the durable log (and the dock) without spending a turn.
   * The machine report rides in `source[REPORT_FIELD]`; the visible text is the
   * human account only.
   */
  const deliverVerdict = (agent, outcome) => {
    if (agent === undefined) return false
    const notice = buildVerdictNotice(outcome.report, outcome.assessment)
    const message = createInboxMessage({
      content: [{ type: 'text', text: notice.text }],
      source: {
        kind: PROBE_SOURCE,
        form: 'notice',
        summary: notice.summary,
        [REPORT_FIELD]: JSON.stringify(outcome.report),
      },
    })
    // `inject()` only adds model-facing context: it is committed when the next
    // step runs. A manual `/guard check` usually ends the turn, so an injected
    // red verdict would sit in the inbox — the projection (and the popup that
    // reads it) would stay empty. Wake the idle agent for red so the message is
    // committed immediately; green/yellow stay zero-cost injections.
    const red = outcome.assessment !== null && outcome.assessment !== undefined && outcome.assessment.level === 'red'
    const running = agent.status === 'running'
    if (red && !running && typeof agent.followup === 'function') {
      try {
        agent.followup(message)
        return 'followup'
      } catch (error) {
        logger.warn(`dsh-context-guard: followup delivery failed, falling back to inject: ${String(error)}`)
      }
    }
    if (typeof agent.inject !== 'function') return false
    agent.inject(message)
    return 'inject'
  }

  /**
   * Ask the model to write the handoff itself.
   *
   * The plugin only knows the deterministic state; the reasons, rejected
   * alternatives and failed attempts live in the model's context. So instead of
   * emitting a sparse file, the request wakes the model with a framework prompt
   * and lets it write the document with its own tools.
   */
  const requestHandoff = (session, agent) => {
    if (agent === undefined || typeof agent.followup !== 'function') return false
    const state = readState(session)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const draftPath = `${options.handoffDir}/HANDOFF-${stamp}.md`
    try {
      agent.followup(
        createInboxMessage({
          content: [{ type: 'text', text: buildHandoffInstruction(state, { draftPath }) }],
          source: { kind: PROBE_SOURCE, form: 'notice', summary: '交接单请求' },
        }),
      )
      return true
    } catch (error) {
      logger.warn(`dsh-context-guard: cannot ask the model to write a handoff: ${String(error)}`)
      return false
    }
  }

  /** Register the client -> host decision endpoint used by the red-verdict popup. */
  const registerHandoffRoute = () => {
    const install = (server) => {
      if (server === undefined || server === null || typeof server.register !== 'function') return false
      try {
        server.register({
          kind: 'exact',
          path: HANDOFF_ROUTE,
          handler: async (request, response) => {
            const send = (code, value) => {
              response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              response.end(JSON.stringify(value))
            }
            if (request.method !== 'POST') return send(405, { ok: false, error: 'POST only' })
            if (!isSameOriginRequest(request)) return send(403, { ok: false, error: 'forbidden' })
            const body = await readJsonBody(request)
            const sessionId = body !== null && typeof body.sessionId === 'string' ? body.sessionId : ''
            const decision = body !== null && (body.decision === 'yes' || body.decision === 'no') ? body.decision : ''
            if (sessionId.length === 0 || decision.length === 0) {
              return send(400, { ok: false, error: 'sessionId and decision are required' })
            }
            if (decision === 'no') return send(200, { ok: true, decision })
            const agent = ctx.agents.get(sessionId)
            if (agent === undefined) return send(404, { ok: false, error: 'session is not live' })
            const requested = requestHandoff(agent.session, agent)
            return send(requested ? 200 : 500, { ok: requested, decision })
          },
        })
        logger.info('dsh-context-guard: handoff decision endpoint registered')
        return true
      } catch (error) {
        logger.warn(`dsh-context-guard: cannot register the handoff endpoint: ${String(error)}`)
        return false
      }
    }

    if (install(serviceOf('webServer'))) return
    // The web server may mount after this plugin. Cordis's dynamic injection
    // calls back once it is available; otherwise the dock falls back to the
    // copy-command button.
    if (typeof ctx.inject === 'function') {
      try {
        ctx.inject(['webServer'], (webCtx) => {
          install(webCtx.webServer)
        })
        return
      } catch (error) {
        logger.warn(`dsh-context-guard: cannot wait for webServer: ${String(error)}`)
      }
    }
    logger.info('dsh-context-guard: no webServer service; the handoff popup falls back to /guard handoff')
  }

  /**
   * One automatic self-check, shared by every structural trigger (compaction,
   * context pressure, step interval). The trigger only decides *when*; the
   * verdict never depends on it.
   */
  const runAutoProbe = (session, reason = 'auto', force = false) => {
    const agent = agentOf(session)
    if (agent === undefined) return
    if (!isRootSession(session)) return
    const now = Date.now()
    const state = readState(session)
    if (state.probe.status === 'queued') return
    // A compression rewrites working memory, so its probe must not be skipped
    // just because a pressure/steps probe ran minutes earlier. Pressure and
    // step triggers keep the cooldown; compaction and compression-drop force.
    if (!force) {
      if (state.probe.answerAt !== null && now - state.probe.answerAt < options.cooldownMs) return
      const last = lastAutoAt.get(session.id) ?? 0
      if (now - last < options.cooldownMs) return
    }
    lastAutoAt.set(session.id, now)

    const run = async () => {
      // `backgroundProbe` is an explicit mode switch, not a "try background
      // first" hint: when it is on, a self-check never dumps the A/B/C
      // questionnaire into the conversation. Only an explicit `false` uses the
      // legacy in-conversation probe.
      if (options.backgroundProbe) {
        if (subagentService() === undefined) {
          logger.warn('dsh-context-guard: backgroundProbe is on but the subagents service is unavailable; leaving the probe due')
          return
        }
        try {
          const outcome = await runBackgroundProbe(session, agent, reason)
          if (outcome !== null) {
            deliverVerdict(agent, outcome)
            logger.info(`dsh-context-guard: background verdict delivered for ${session.id} (${reason})`)
            return
          }
          logger.warn('dsh-context-guard: background probe produced no verdict; leaving the probe due')
          return
        } catch (error) {
          logger.warn(`dsh-context-guard: background probe failed: ${String(error)}`)
          return
        }
      }
      try {
        queueProbe(agent, 'auto')
        logger.info(`dsh-context-guard: auto probe queued for ${session.id} (${reason})`)
      } catch (error) {
        logger.warn(`dsh-context-guard: auto probe failed: ${String(error)}`)
      }
    }
    void run().catch((error) => {
      logger.warn(`dsh-context-guard: auto probe crashed: ${String(error)}`)
    })
  }

  /** Run the auto-probe after a compaction settles. */
  const maybeAutoProbe = (session, compactionSeq) => {
    const state = readState(session)
    if (state.probe.status !== 'due') return
    if (state.probe.forCompactionSeq !== compactionSeq) return
    if (state.lastCompaction?.seq !== compactionSeq) return
    if (state.lastCompaction?.failed === true) return
    // Compaction rewrote memory: probe even if a pressure check just ran.
    runAutoProbe(session, 'compaction', true)
  }

  /** Current request size as a fraction of the model window, when measurable. */
  const pressureOf = (session, state) => {
    const meter = serviceOf('tokenMeter')
    if (meter === undefined || typeof meter.measure !== 'function') return null
    let measurement
    try {
      measurement = meter.measure(session)
    } catch {
      return null
    }
    const total = typeof measurement?.totalTokens === 'number' ? measurement.totalTokens : null
    const window = typeof state.request?.contextWindow === 'number' ? state.request.contextWindow : null
    if (total === null || window === null || window <= 0) return null
    return total / window
  }

  /** Structural trigger: context pressure or step interval, no compaction needed. */
  const maybePressureProbe = (session) => {
    if (!options.pressureProbe) return
    if (agentOf(session) === undefined || !isRootSession(session)) return
    const state = readState(session)
    const ratio = pressureOf(session, state)
    if (ratio === null || ratio < options.pressureThreshold) return
    logger.info(`dsh-context-guard: pressure ${Math.round(ratio * 100)}% crossed threshold, running a check`)
    runAutoProbe(session, 'pressure')
  }

  /**
   * Structural trigger for compression that happens outside DSH's own session
   * events.
   *
   * billion-context and other proxy-level compressors fold history in front of
   * the host, so `compaction/end` never arrives and the normal post-compaction
   * probe would not fire. The observable trace is a sudden, large drop in the
   * measured request size; re-test after it. The cooldown in `runAutoProbe`
   * suppresses duplicates when a native compaction event also fired.
   */
  const maybeCompressionDropProbe = (session) => {
    if (agentOf(session) === undefined || !isRootSession(session)) return
    const meter = serviceOf('tokenMeter')
    if (meter === undefined || typeof meter.measure !== 'function') return
    let total = null
    try {
      const measurement = meter.measure(session)
      total = typeof measurement?.totalTokens === 'number' ? measurement.totalTokens : null
    } catch {
      return
    }
    if (total === null) return
    const previous = lastTotals.get(session.id)
    lastTotals.set(session.id, total)
    if (previous === undefined) return
    const dropped = previous - total
    // Estimates move by a few percent on their own; a real fold removes at
    // least 40% of a 10k+ request.
    if (dropped < 10000 || total > previous * 0.6) return
    logger.info(
      `dsh-context-guard: request shrank ${previous} -> ${total} tokens, treating it as an external compression and re-checking`,
    )
    runAutoProbe(session, 'compression-drop', true)
  }

  /** Defer the probe so the compaction turn has a chance to settle. */
  const scheduleAutoProbe = (session, compactionSeq) => {
    if (!options.autoProbe) return
    const existing = timers.get(session.id)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      timers.delete(session.id)
      try {
        maybeAutoProbe(session, compactionSeq)
      } catch (error) {
        logger.warn(`dsh-context-guard: deferred auto probe failed: ${String(error)}`)
      }
    }, options.probeDelayMs)
    if (typeof timer.unref === 'function') timer.unref()
    timers.set(session.id, timer)
  }

  // The projection is the durable truth: it folds compactions, file writes,
  // probe messages, answers, and /guard verdicts from the session log.
  ctx.sessionProjections.register({
    key: 'contextGuard',
    stateSchema,
    stateVersion: 6,
    init: (header) => initialGuardState(header),
    apply: applyGuardEvent,
    wire: {
      viewSchema,
      view: cacheView,
    },
  })

  // The red-verdict popup calls this endpoint; it never asks the user to type
  // a command. No webServer? The dock falls back to copying /guard handoff.
  registerHandoffRoute()

  // Triggers: a successful compaction means working memory was rewritten;
  // context pressure and the step interval catch long sessions that never
  // compact. All three only decide *when* to test — never how to grade.
  ctx.on('session/event', (session, event) => {
    const type = event?.type
    if (type === 'compaction/end') {
      if (event.data?.error !== undefined && event.data?.error !== null) return
      scheduleAutoProbe(session, event.seq)
      return
    }
    if (type === 'step/end') {
      const count = (stepCounts.get(session.id) ?? 0) + 1
      stepCounts.set(session.id, count)
      if (options.stepProbeInterval > 0 && count % options.stepProbeInterval === 0) {
        try {
          runAutoProbe(session, 'steps')
        } catch (error) {
          logger.warn(`dsh-context-guard: step trigger failed: ${String(error)}`)
        }
      }
      return
    }
    if (type === 'turn/end') {
      try {
        maybePressureProbe(session)
      } catch (error) {
        logger.warn(`dsh-context-guard: pressure trigger failed: ${String(error)}`)
      }
      try {
        maybeCompressionDropProbe(session)
      } catch (error) {
        logger.warn(`dsh-context-guard: compression-drop trigger failed: ${String(error)}`)
      }
    }
  })

  ctx.commands.register({
    name: 'guard',
    description:
      '上下文交接哨兵：压缩后做三项行为自检（约束 / 已改文件 / 下一步+验证命令），判定 🟢🟡🔴 并生成交接单',
    input: {
      hint: '[status|check|green|yellow|red [原因]|pin <约束>|handoff|reset]',
    },
    handler: async ({ agent, rawInput }) => {
      if (agent === undefined || agent === null) {
        return { kind: 'error', text: '当前没有可用的 agent。' }
      }
      const session = agent.session
      const state = readState(session)
      const command = parseGuardCommand(rawInput)

      if (command.verb === 'status' || command.verb === 'help') {
        const usage = [
          '',
          '用法：',
          '- `/guard check`：立即触发一次三项行为自检',
          '- `/guard green|yellow|red [原因]`：人工记录判定',
          '- `/guard pin <约束>`：固定一条不可动约束（会出现在交接单里）',
          '- `/guard unpin <序号|all>`：删除固定约束',
          '- `/guard handoff`：生成交接单文件 + 新对话开场白',
          '- `/guard reset`：清空当前自检/判定（保留固定约束和文件记录）',
          '- `/guard show`：恢复被 × 隐藏的哨兵条（后台自检一直在跑）',
        ].join('\n')
        return { kind: 'success', text: `${buildStatusText(state)}${usage}` }
      }

      if (command.verb === 'prompt') {
        return { kind: 'success', text: buildProbePrompt('manual') }
      }

      if (command.verb === 'check') {
        if (state.probe.status === 'queued') {
          return {
            kind: 'success',
            text: '已经有一次自检在等待模型回答；等它结束，或先发一条消息打断它。',
          }
        }
        if (options.backgroundProbe) {
          if (subagentService() === undefined) {
            return {
              kind: 'error',
              text: [
                '后台自检不可用：当前组合没有加载 `subagents` 服务（或没有 startActivation）。',
                '把插件配置里的 `backgroundProbe` 设为 false 可以退回旧的“在对话里回答 A/B/C”模式。',
              ].join('\n'),
            }
          }
          try {
            const outcome = await runBackgroundProbe(session, agent, 'manual')
            if (outcome === null) {
              return {
                kind: 'error',
                text: [
                  '后台自检没有产出可解析的报告（子 agent 没给出 DSH_GUARD_JSON，或后端被取消/超时）。',
                  '对话里不会出现 A/B/C 内容；可以再试一次。',
                ].join('\n'),
              }
            }
            deliverVerdict(agent, outcome)
            // `/guard check` returns the full state of record: a separate
            // `/guard status` run is no longer needed to see the verdict.
            return { kind: 'success', text: buildStatusText(withFreshReport(state, outcome)) }
          } catch (error) {
            logger.warn(`dsh-context-guard: background self-check failed: ${String(error)}`)
            return { kind: 'error', text: `后台自检失败：${String(error)}` }
          }
        }
        try {
          queueProbe(agent, 'manual')
        } catch (error) {
          return { kind: 'error', text: `无法把自检排入下一轮：${String(error)}` }
        }
        return {
          kind: 'success',
          text: [
            '三项行为自检已排入下一轮。',
            '模型会先回答 A 约束 / B 已改文件+原因 / C 下一步+验证命令，再输出 DSH_GUARD_JSON。',
            '回答结束后运行 `/guard status` 查看证据核对结果；不要只看压缩次数。',
          ].join('\n'),
        }
      }

      if (command.verb === 'verdict') {
        const level = command.level
        if (options.injectAdvice) {
          try {
            if (typeof agent.inject === 'function') {
              agent.inject(
                createInboxMessage({
                  content: [{ type: 'text', text: buildAdviceMessage(level) }],
                  source: { kind: PROBE_SOURCE },
                }),
              )
            }
          } catch (error) {
            logger.warn(`dsh-context-guard: could not inject advice: ${String(error)}`)
          }
        }
        const reason = command.reason.length > 0 ? `原因：${command.reason}` : '（未填写原因）'
        return {
          kind: 'success',
          text: `已记录人工判定：${level.toUpperCase()}\n${adviceFor(level)}\n${reason}`,
        }
      }

      if (command.verb === 'pin') {
        const text = command.text.trim()
        if (text.length === 0) return { kind: 'error', text: '用法：`/guard pin <约束正文>`' }
        return {
          kind: 'success',
          text: `已记录第 ${state.pins.length + 1} 条固定约束：\n> ${text}\n\n它会在下一次行为自检和交接单里作为核对基准。`,
        }
      }

      if (command.verb === 'unpin') {
        if (command.text === 'all') return { kind: 'success', text: '已清空固定约束。' }
        return { kind: 'success', text: `已请求删除固定约束 #${command.text || '?'}。` }
      }

      if (command.verb === 'reset') {
        return {
          kind: 'success',
          text: '已清空自检/判定/压缩记录；固定约束和文件记录保留。',
        }
      }

      if (command.verb === 'show') {
        return {
          kind: 'success',
          text: '哨兵条已恢复显示（它是自己隐藏的，后台自检从未停止）。',
        }
      }

      if (command.verb === 'handoff') {
        // Default: the model writes the document. It is the only participant
        // that knows why plans were rejected and what was tried and failed, so
        // asking it beats emitting a sparse file from deterministic state.
        // `/guard handoff draft` still writes the deterministic fallback.
        if (command.text !== 'draft' && requestHandoff(session, agent)) {
          return {
            kind: 'success',
            text: [
              '已把写交接单的请求交给模型。',
              '它会按十段框架写一份完整文档（授权边界 / 目标与验收 / 进度盘点 / 决策与被否决 / 文件清单 / 坑与失败 / 卡点 / 下一步 / 约束 / 复跑命令），完成后回复文件路径。',
              '想要不依赖模型的确定性草稿，用 `/guard handoff draft`。',
            ].join('\n'),
          }
        }
        const cwd = typeof session.header?.cwd === 'string' && session.header.cwd.length > 0 ? session.header.cwd : process.cwd()
        let measurement = null
        try {
          const meter = ctx.get('tokenMeter', false)
          if (meter !== undefined && typeof meter.measure === 'function') {
            measurement = meter.measure(session)
          }
        } catch (error) {
          logger.warn(`dsh-context-guard: token meter unavailable: ${String(error)}`)
        }
        let pressure = null
        try {
          pressure = ctx.sessionProjections.stateOf(session, 'contextPressure') ?? null
        } catch {
          pressure = null
        }
        const markdown = buildHandoffMarkdown({
          state,
          sessionId: session.id,
          measurement,
          pressure,
          fileExists: (abs) => existsSync(abs),
        })
        const dir = isAbsolute(options.handoffDir) ? options.handoffDir : resolve(cwd, options.handoffDir)
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const file = resolve(dir, `${session.id}-${stamp}.md`)
        try {
          await mkdir(dir, { recursive: true })
          await writeFile(file, markdown, 'utf8')
          return {
            kind: 'success',
            text: `交接单已写入：\n${file}\n\n---\n${markdown}`,
          }
        } catch (error) {
          return {
            kind: 'success',
            text: `交接单文件写入失败：${String(error)}\n下面是完整内容，请手动保存：\n\n---\n${markdown}`,
          }
        }
      }

      return {
        kind: 'error',
        text: `未知的 /guard 子命令：${command.text}\n可用：check / green / yellow / red / pin / unpin / handoff / status / reset`,
      }
    },
  })

  ctx.effect(() => () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    lastAutoAt.clear()
    lastTotals.clear()
  }, 'dsh-context-guard: timers')

  logger.info(
    `dsh-context-guard ready (autoProbe=${String(options.autoProbe)}, rootsOnly=${String(options.rootsOnly)}, cooldown=${options.cooldownMs}ms)`,
  )
}

// Keep unused imports referenced in a way bundlers can see intent; these are
// the markers the client/host share.
export const markers = { PROBE_MARKER, ADVICE_MARKER }
