/**
 * Pure logic for dsh-context-guard.
 *
 * Nothing in this file imports a DSH package, so it can be unit tested with
 * plain Node and the host plugin can stay dependency-free.
 *
 * The central rule of this plugin:
 *   compression count is metadata, never a verdict.
 * The only verdict is the three-part behavioral self-check requested after a
 * compaction: constraints, changed files + reasons, next step + verify command.
 */

import { isAbsolute, normalize, relative, resolve } from 'node:path'

/** Source kind used by the probe/advice messages this plugin injects. */
export const PROBE_SOURCE = 'dsh-context-guard'
/** Marker that identifies the real self-check prompt (advice messages do not carry it). */
export const PROBE_MARKER = '[[DSH-CONTEXT-GUARD:PROBE:'
/** Marker used by short advisory injections so the fold can ignore them. */
export const ADVICE_MARKER = '[[DSH-CONTEXT-GUARD:ADVICE]]'
/**
 * Source field carrying the machine report of a background self-check.
 *
 * Background probes run in a fork child, so their answer never reaches this
 * session's log. The host folds the parsed report back into the parent by
 * injecting one message whose `source[REPORT_FIELD]` holds the raw JSON text;
 * the visible content stays human-readable and the projection keeps its
 * durable, restart-safe state.
 */
export const REPORT_FIELD = 'guardReport'
/** Wire/state semantic version. Bump when the fold semantics change. */
export const STATE_VERSION = 6

const MAX_FILES = 200
const MAX_PINS = 20
const MAX_PENDING_WRITES = 40
const MAX_PENDING_COMMANDS = 8
const MAX_REPORT_CONSTRAINTS = 40
const MAX_REPORT_FILES = 100
const MAX_REPORT_VERIFY = 20
const MAX_REPORT_UNKNOWNS = 20
const MAX_ANSWER_TEXT = 12000

const VERDICTS = new Set(['green', 'yellow', 'red'])
const LEVEL_ORDER = { green: 0, yellow: 1, red: 2 }

/**
 * File-memory severity.
 *
 * Omitting a few scratch files is noise. Omitting more than half of the written
 * files is a yellow contradiction. Omitting almost all of them — >=90% and at
 * least 10 files — means the context can no longer account for its own work,
 * which is exactly what red exists for: hand off instead of continuing.
 */
const MISSING_RATIO_YELLOW = 0.5
const MISSING_COUNT_YELLOW = 2
const MISSING_RATIO_RED = 0.9
const MISSING_COUNT_RED = 10

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringOr(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function stringArray(value, max) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return list
    .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, max)
}

function touch(state, patch, time) {
  return { ...state, ...patch, updatedAt: numberOr(time, state.updatedAt) }
}

function emptyProbe() {
  return {
    status: 'none',
    forCompactionSeq: null,
    promptSeq: null,
    promptAt: null,
    answerSeq: null,
    answerAt: null,
    answeredForCompactionSeq: null,
    requestedBy: null,
    answerText: '',
  }
}

/**
 * Initial projection state.
 * @param {{cwd?: string}} header - the owned session header (init receives it).
 */
export function initialGuardState(header = {}) {
  return {
    v: STATE_VERSION,
    cwd: stringOr(header?.cwd),
    compactions: 0,
    lastCompaction: null,
    lastSummary: null,
    probe: emptyProbe(),
    report: null,
    userVerdict: null,
    pins: [],
    files: [],
    pendingWrites: [],
    pendingCommands: [],
    request: null,
    // Bumped by `/guard show`; the client hides the dock when its stored epoch
    // matches this value, so a hidden dock can always be brought back.
    dockEpoch: 0,
    updatedAt: 0,
  }
}

/** Minimal schemastery/zod-shaped validator for registry checkpoints. */
export const stateSchema = {
  parse(raw) {
    if (!isObject(raw)) throw new Error('contextGuard state must be an object')
    if (raw.v !== STATE_VERSION) throw new Error(`unsupported contextGuard state version: ${String(raw.v)}`)
    return raw
  },
}

/** Minimal schema for the client-facing wire view. */
export const viewSchema = {
  parse(raw) {
    if (!isObject(raw) || raw.v !== STATE_VERSION) throw new Error('invalid contextGuard view')
    return raw
  },
}

/** Extract plain text from a content-block array; reasoning blocks are ignored on purpose. */
export function textOfContent(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** Whether a compaction/end event represents a successful compaction. */
function compactionFailed(data) {
  return data?.error !== undefined && data?.error !== null
}

/**
 * Fold one committed session event into the guard state.
 * Must be synchronous and return the same state object for unrelated events.
 */
export function applyGuardEvent(state, event) {
  if (!isObject(event) || typeof event.type !== 'string') return state
  const time = numberOr(event.time, state.updatedAt)
  const data = isObject(event.data) ? event.data : {}

  switch (event.type) {
    case 'request/context': {
      return touch(state, {
        request: {
          provider: typeof data.provider === 'string' ? data.provider : state.request?.provider,
          model: typeof data.model === 'string' ? data.model : state.request?.model,
          contextWindow: typeof data.contextWindow === 'number' ? data.contextWindow : state.request?.contextWindow,
          at: time,
        },
      }, time)
    }

    case 'compaction/summary': {
      return touch(state, {
        lastSummary: {
          compactionId: typeof data.compactionId === 'string' ? data.compactionId : undefined,
          shadowedTokens: typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : undefined,
          shadowedCount: Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : undefined,
          provider: typeof data.provider === 'string' ? data.provider : undefined,
          model: typeof data.model === 'string' ? data.model : undefined,
          seq: event.seq,
          at: time,
        },
      }, time)
    }

    case 'compaction/end': {
      const failed = compactionFailed(data)
      const summary =
        state.lastSummary !== null &&
        (typeof data.compactionId !== 'string' || state.lastSummary.compactionId === data.compactionId)
          ? state.lastSummary
          : null
      const lastCompaction = {
        seq: numberOr(event.seq, 0),
        time,
        compactionId: typeof data.compactionId === 'string' ? data.compactionId : summary?.compactionId,
        shadowedTokens: summary?.shadowedTokens,
        shadowedCount: summary?.shadowedCount,
        provider: summary?.provider,
        model: summary?.model,
        sourceCommandId: typeof data.sourceCommandId === 'string' ? data.sourceCommandId : undefined,
        failed,
        error: failed ? stringOr(data.error?.message, String(data.error)).slice(0, 500) : undefined,
      }
      if (failed) {
        return touch(state, { lastCompaction, lastSummary: null }, time)
      }
      return touch(state, {
        compactions: state.compactions + 1,
        lastCompaction,
        lastSummary: null,
        probe: {
          ...emptyProbe(),
          status: 'due',
          forCompactionSeq: lastCompaction.seq,
          answeredForCompactionSeq: state.probe.answeredForCompactionSeq,
        },
        userVerdict: null,
      }, time)
    }

    case 'tool/call': {
      const write = writeFromToolCall(data.name, data.arguments, state.cwd)
      if (write === null) return state
      const callId = typeof data.callId === 'string' ? data.callId : ''
      if (callId.length === 0) return state
      const pendingWrites = [
        ...state.pendingWrites.filter((entry) => entry.callId !== callId),
        { ...write, callId, seq: numberOr(event.seq, 0), at: time },
      ].slice(-MAX_PENDING_WRITES)
      return touch(state, { pendingWrites }, time)
    }

    case 'tool/result': {
      const message = isObject(data.message) ? data.message : {}
      const callId =
        typeof message.toolCallId === 'string'
          ? message.toolCallId
          : typeof message.callId === 'string'
            ? message.callId
            : isObject(message.source) && typeof message.source.callId === 'string'
              ? message.source.callId
              : ''
      if (callId.length === 0) return state
      const pending = state.pendingWrites.find((entry) => entry.callId === callId)
      if (pending === undefined) return state
      const pendingWrites = state.pendingWrites.filter((entry) => entry.callId !== callId)
      if (message.isError === true || data.error !== undefined) {
        return touch(state, { pendingWrites }, time)
      }
      return touch(state, {
        pendingWrites,
        files: mergeFileRecord(state.files, pending, time),
      }, time)
    }

    case 'user/message': {
      const sourceKind = isObject(data.source) ? stringOr(data.source.kind) : ''
      if (sourceKind === PROBE_SOURCE) {
        // Background self-check: the fork child answered in its own session, so
        // the host folds the parsed report back by injecting one message whose
        // source carries the raw JSON. Fold it exactly like a turn/end answer.
        const machine = isObject(data.source) ? data.source[REPORT_FIELD] : undefined
        if (typeof machine === 'string' && machine.trim().length > 0) {
          const report = parseReport(
            machine.includes('{') ? `DSH_GUARD_JSON: ${machine}` : machine,
            time,
            numberOr(event.seq, 0),
            state.lastCompaction?.seq ?? null,
          )
          if (report === null) return state
          report.assessment = assessReport(state, report)
          return touch(state, {
            probe: {
              ...state.probe,
              status: 'answered',
              answerSeq: numberOr(event.seq, 0),
              answerAt: time,
              answeredForCompactionSeq: state.lastCompaction?.seq ?? state.probe.forCompactionSeq,
              answerText: '',
            },
            report,
          }, time)
        }
        const text = textOfContent(data.content)
        if (!text.includes(PROBE_MARKER)) return state // advisory injection
        if (state.probe.status === 'queued' && state.probe.promptSeq !== null) return state
        const after = text.slice(text.indexOf(PROBE_MARKER) + PROBE_MARKER.length)
        const requestedBy = after.split(']]')[0].trim() || 'auto'
        return touch(state, {
          probe: {
            ...state.probe,
            status: 'queued',
            forCompactionSeq: state.lastCompaction?.seq ?? state.probe.forCompactionSeq,
            promptSeq: numberOr(event.seq, 0),
            promptAt: time,
            requestedBy,
            answerSeq: null,
            answerAt: null,
            answerText: '',
          },
        }, time)
      }
      if (state.probe.status === 'queued') {
        // The user cut in before the probe's turn ended; do not keep waiting forever.
        return touch(state, { probe: { ...state.probe, status: 'skipped' } }, time)
      }
      return state
    }

    case 'assistant/message': {
      if (state.probe.status !== 'queued') return state
      const message = isObject(data.message) ? data.message : {}
      const text = textOfContent(message.content)
      if (text.trim().length === 0) return state
      const answerText = `${state.probe.answerText}\n${text}`.slice(-MAX_ANSWER_TEXT)
      return touch(state, { probe: { ...state.probe, answerText } }, time)
    }

    case 'turn/end': {
      if (state.probe.status !== 'queued') return state
      const report = parseReport(state.probe.answerText, time, numberOr(event.seq, 0), state.lastCompaction?.seq ?? null)
      const probe = {
        ...state.probe,
        status: 'answered',
        answerSeq: numberOr(event.seq, state.probe.answerSeq),
        answerAt: time,
        answeredForCompactionSeq: state.probe.forCompactionSeq,
        answerText: '',
      }
      if (report === null) {
        return touch(state, { probe }, time)
      }
      report.assessment = assessReport(state, report)
      return touch(state, { probe, report }, time)
    }

    case 'command/run': {
      if (data.name !== 'guard') return state
      const commandId = typeof data.commandId === 'string' ? data.commandId : ''
      if (commandId.length === 0) return state
      const pendingCommands = [
        ...state.pendingCommands.filter((entry) => entry.commandId !== commandId),
        { commandId, args: stringOr(data.args), seq: numberOr(event.seq, 0) },
      ].slice(-MAX_PENDING_COMMANDS)
      return touch(state, { pendingCommands }, time)
    }

    case 'command/done': {
      const commandId = typeof data.commandId === 'string' ? data.commandId : ''
      if (commandId.length === 0) return state
      const pending = state.pendingCommands.find((entry) => entry.commandId === commandId)
      if (pending === undefined) return state
      const pendingCommands = state.pendingCommands.filter((entry) => entry.commandId !== commandId)
      if (data.kind !== 'success') return touch(state, { pendingCommands }, time)
      return applyGuardCommand(state, pending.args, data.text, time, numberOr(event.seq, 0), pendingCommands)
    }

    default:
      return state
  }
}

/** Apply a successful `/guard` command's state transition. */
function applyGuardCommand(state, args, resultText, time, seq, pendingCommands) {
  const command = parseGuardCommand(args)
  let patch = { pendingCommands }
  if (command.verb === 'verdict') {
    patch = {
      ...patch,
      userVerdict: {
        level: command.level,
        reason: (command.reason.length > 0 ? command.reason : '人工判定').slice(0, 1000),
        at: time,
        seq,
      },
      probe: {
        ...state.probe,
        status: 'answered',
        answerSeq: seq,
        answerAt: time,
        answeredForCompactionSeq: state.lastCompaction?.seq ?? state.probe.forCompactionSeq,
        answerText: '',
      },
    }
  } else if (command.verb === 'pin') {
    const text = command.text.trim().slice(0, 1000)
    if (text.length > 0) {
      const pins = [
        ...state.pins.filter((pin) => pin.text !== text),
        { text, at: time, seq },
      ].slice(-MAX_PINS)
      patch = { ...patch, pins }
    }
  } else if (command.verb === 'unpin') {
    if (command.text === 'all') patch = { ...patch, pins: [] }
    else {
      const index = Number.parseInt(command.text, 10)
      if (Number.isSafeInteger(index) && index > 0 && index <= state.pins.length) {
        patch = { ...patch, pins: state.pins.filter((_, i) => i !== index - 1) }
      }
    }
  } else if (command.verb === 'reset') {
    patch = {
      ...patch,
      compactions: 0,
      lastCompaction: null,
      lastSummary: null,
      probe: emptyProbe(),
      report: null,
      userVerdict: null,
    }
  } else if (command.verb === 'show') {
    patch = { ...patch, dockEpoch: numberOr(state.dockEpoch, 0) + 1 }
  }
  return touch(state, patch, time)
}

/**
 * The command grammar under `/guard`.
 * @param {string} raw - everything after the command name.
 */
export function parseGuardCommand(raw) {
  const input = stringOr(raw).trim()
  if (input.length === 0) return { verb: 'status', text: '' }
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input)
  const head = (match?.[1] ?? '').toLowerCase()
  const tail = (match?.[2] ?? '').trim()
  if (head === 'green' || head === 'yellow' || head === 'red') {
    return { verb: 'verdict', level: head, reason: tail }
  }
  if (head === 'pin') return { verb: 'pin', text: tail }
  if (head === 'unpin') return { verb: 'unpin', text: tail.toLowerCase() }
  if (head === 'check' || head === 'status' || head === 'prompt' || head === 'handoff' || head === 'reset' || head === 'show' || head === 'help') {
    return { verb: head, text: tail }
  }
  return { verb: 'unknown', text: input }
}

/** Normalize one path against the session cwd. */
export function normalizePath(cwd, path) {
  if (typeof path !== 'string' || path.trim().length === 0) return null
  const raw = path.trim().replace(/^[`'"]+|[`'"]+$/g, '')
  if (raw.length === 0) return null
  try {
    return normalize(isAbsolute(raw) ? raw : resolve(cwd || process.cwd(), raw))
  } catch {
    return null
  }
}

/** Display a path relative to the session cwd when it is inside it. */
export function displayPath(cwd, abs) {
  if (typeof abs !== 'string' || abs.length === 0) return ''
  if (typeof cwd !== 'string' || cwd.length === 0) return abs
  try {
    const rel = relative(cwd, abs)
    if (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) return rel
  } catch {
    // fall through
  }
  return abs
}

function lineCount(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let lines = text.split('\n').length
  if (text.endsWith('\n')) lines -= 1
  return Math.max(0, lines)
}

function sizeOfChange(addedText, removedText) {
  return { added: lineCount(addedText), removed: lineCount(removedText) }
}

/** Extract the write footprint of one file-writing tool call, if any. */
export function writeFromToolCall(name, rawArguments, cwd) {
  if (typeof name !== 'string' || typeof rawArguments !== 'string') return null
  let args
  try {
    args = JSON.parse(rawArguments)
  } catch {
    return null
  }
  if (!isObject(args)) return null
  const path = typeof args.path === 'string' ? args.path : typeof args.file_path === 'string' ? args.file_path : undefined
  if (path === undefined) return null
  const abs = normalizePath(cwd, path)
  if (abs === null) return null
  let footprint = { added: 0, removed: 0 }
  if (name === 'write') {
    footprint = sizeOfChange(stringOr(args.content), undefined)
  } else if (name === 'edit') {
    footprint = sizeOfChange(stringOr(args.new_string), stringOr(args.old_string))
  } else if (name === 'str_replace_editor') {
    const command = stringOr(args.command)
    if (command === 'create') footprint = sizeOfChange(stringOr(args.file_text), undefined)
    else if (command === 'str_replace') footprint = sizeOfChange(stringOr(args.new_str), stringOr(args.old_str))
    else if (command === 'insert') footprint = sizeOfChange(stringOr(args.new_str), undefined)
    else return null
  } else {
    return null
  }
  return { path, abs, ...footprint }
}

function mergeFileRecord(files, write, time) {
  const existing = files.find((entry) => entry.abs === write.abs)
  let next
  if (existing === undefined) {
    next = {
      path: write.path,
      abs: write.abs,
      writes: 1,
      added: write.added,
      removed: write.removed,
      lastAt: time,
    }
  } else {
    next = {
      ...existing,
      path: write.path,
      writes: existing.writes + 1,
      added: existing.added + write.added,
      removed: existing.removed + write.removed,
      lastAt: Math.max(existing.lastAt, time),
    }
  }
  const merged = files.map((entry) => (entry.abs === write.abs ? next : entry))
  if (!files.some((entry) => entry.abs === write.abs)) merged.push(next)
  return merged.sort((left, right) => right.lastAt - left.lastAt).slice(0, MAX_FILES)
}

/**
 * Parse the machine-readable report the probe asks the model to emit.
 * Accepted forms: a `DSH_GUARD_JSON:` line, a ```json fenced block, or an
 * object carrying a `verdict` plus at least one report field.
 */
export function parseReport(text, at, seq, forCompactionSeq) {
  if (typeof text !== 'string' || text.length === 0) return null
  const candidates = []
  const marker = 'DSH_GUARD_JSON'
  const markerIndex = text.indexOf(marker)
  if (markerIndex !== -1) {
    const brace = text.indexOf('{', markerIndex)
    if (brace !== -1) candidates.push(brace)
  }
  const fence = /```(?:json)?\s*/gi
  for (const match of text.matchAll(fence)) {
    const brace = text.indexOf('{', match.index + match[0].length)
    if (brace !== -1) candidates.push(brace)
  }
  const anyBrace = text.indexOf('{')
  if (anyBrace !== -1) candidates.push(anyBrace)
  const seen = new Set()
  for (const start of candidates) {
    if (seen.has(start)) continue
    seen.add(start)
    const raw = extractBalancedJson(text, start)
    if (raw === null) continue
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      continue
    }
    const report = normalizeReport(parsed, at, seq, forCompactionSeq)
    if (report !== null) return report
  }
  return null
}

/** Extract one balanced JSON object starting at `start`. */
export function extractBalancedJson(text, start) {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

function normalizeVerdict(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim().toLowerCase()
  if (VERDICTS.has(text)) return text
  if (text === '🟢' || text === '绿' || text === '绿灯' || text === 'g') return 'green'
  if (text === '🟡' || text === '黄' || text === '黄灯' || text === 'y') return 'yellow'
  if (text === '🔴' || text === '红' || text === '红灯' || text === 'r') return 'red'
  return ''
}

function normalizeReport(raw, at, seq, forCompactionSeq) {
  if (!isObject(raw)) return null
  const verdict = normalizeVerdict(raw.verdict)
  if (!VERDICTS.has(verdict)) return null
  const constraints = Array.isArray(raw.constraints)
    ? raw.constraints
        .map((entry) =>
          typeof entry === 'string'
            ? { text: entry, source: '', certain: true }
            : isObject(entry)
              ? {
                  text: stringOr(entry.text),
                  source: stringOr(entry.source),
                  certain: entry.certain !== false,
                }
              : null,
        )
        .filter((entry) => entry !== null && entry.text.trim().length > 0)
        .slice(0, MAX_REPORT_CONSTRAINTS)
    : []
  const files = Array.isArray(raw.files)
    ? raw.files
        .map((entry) =>
          typeof entry === 'string'
            ? { path: entry, change: '', reason: '', certain: true }
            : isObject(entry)
              ? {
                  path: stringOr(entry.path),
                  change: stringOr(entry.change),
                  reason: stringOr(entry.reason),
                  certain: entry.certain !== false,
                }
              : null,
        )
        .filter((entry) => entry !== null && entry.path.trim().length > 0)
        .slice(0, MAX_REPORT_FILES)
    : []
  const verifyList = Array.isArray(raw.verify) ? raw.verify : typeof raw.verify === 'string' ? [raw.verify] : []
  const unknownList = Array.isArray(raw.unknowns) ? raw.unknowns : typeof raw.unknowns === 'string' ? [raw.unknowns] : []
  const verify = verifyList
    .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, MAX_REPORT_VERIFY)
  const unknowns = unknownList
    .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, MAX_REPORT_UNKNOWNS)
  const done = stringArray(raw.done, 20)
  const failedAttempts = stringArray(raw.failedAttempts, 20)
  const verified = Array.isArray(raw.verified)
    ? raw.verified
        .map((entry) =>
          typeof entry === 'string'
            ? { command: entry.trim(), result: '' }
            : isObject(entry)
              ? { command: stringOr(entry.command).trim(), result: stringOr(entry.result).trim() }
              : null,
        )
        .filter((entry) => entry !== null && entry.command.length > 0)
        .slice(0, 20)
    : []
  const decisions = Array.isArray(raw.decisions)
    ? raw.decisions
        .map((entry) =>
          typeof entry === 'string'
            ? { decision: entry.trim(), reason: '', rejected: false }
            : isObject(entry)
              ? {
                  decision: stringOr(entry.decision).trim(),
                  reason: stringOr(entry.reason).trim(),
                  rejected: entry.rejected === true,
                }
              : null,
        )
        .filter((entry) => entry !== null && entry.decision.length > 0)
        .slice(0, 20)
    : []
  return {
    verdict,
    constraints,
    files,
    nextStep: stringOr(raw.nextStep),
    verify,
    unknowns,
    objective: stringOr(raw.objective).trim().slice(0, 500),
    done,
    verified,
    decisions,
    failedAttempts,
    spotCheckFile: stringOr(raw.spotCheckFile),
    notes: stringOr(raw.notes),
    at: numberOr(at, 0),
    seq: numberOr(seq, 0),
    forCompactionSeq,
    assessment: null,
  }
}

function normalizeForMatch(text) {
  return stringOr(text)
    .toLowerCase()
    .replace(/[\s`*_#\-—:：;；,.，。!?！？"'“”‘’()（）[\]【】{}<>《》|/\\]+/g, '')
}

function bigrams(text) {
  const normalized = normalizeForMatch(text)
  const grams = []
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.push(normalized.slice(index, index + 2))
  }
  return grams
}

/** Heuristic: did the report's constraint text preserve this pinned constraint? */
export function matchesPin(pinText, reportTexts) {
  const haystack = reportTexts.join('\n')
  const normalizedPin = normalizeForMatch(pinText)
  if (normalizedPin.length === 0) return true
  if (normalizedPin.length <= 6) return normalizeForMatch(haystack).includes(normalizedPin)
  const grams = bigrams(pinText)
  if (grams.length === 0) return normalizeForMatch(haystack).includes(normalizedPin)
  const hay = normalizeForMatch(haystack)
  let matched = 0
  for (const gram of grams) {
    if (hay.includes(gram)) matched += 1
  }
  return matched / grams.length >= 0.55
}

function bump(level, next) {
  return LEVEL_ORDER[next] > LEVEL_ORDER[level] ? next : level
}

/**
 * Deterministic evidence check of one model self-report.
 *
 * Policy: the model's own verdict is the baseline, and evidence only overrides
 * it on a *hard* contradiction (recalled constraints that are provably wrong,
 * a report that lists no files while many were written, no next step at all).
 * Ordinary bookkeeping noise — a few helper files omitted, shell-written paths
 * the native write tools never saw, honestly declared unknowns — is reported as
 * context but never demotes the verdict. The old policy graded every blemish as
 * a demotion, which turned a healthy 29%-context conversation yellow.
 *
 * A second calibration fixed the opposite failure: 59 of 64 written files
 * omitted (92%) still capped at yellow while the model claimed green. File
 * memory at that level is gone, so the critical tier now returns red.
 */
export function assessReport(state, report) {
  const reasons = []
  const notes = []
  const checks = { constraints: 'n/a', files: 'n/a', next: 'n/a' }
  let level = VERDICTS.has(report.verdict) ? report.verdict : 'green'

  const reportConstraintTexts = report.constraints.map((entry) => entry.text)
  const reportPaths = report.files
    .map((entry) => normalizePath(state.cwd, entry.path))
    .filter((path) => path !== null)
  const actualPaths = state.files.map((entry) => entry.abs)
  const actualSet = new Set(actualPaths)
  const reportSet = new Set(reportPaths)
  const missing = actualPaths.filter((path) => !reportSet.has(path))
  const phantom = reportPaths.filter((path) => !actualSet.has(path))

  if (state.pins.length > 0) {
    const matched = state.pins.filter((pin) => matchesPin(pin.text, reportConstraintTexts)).length
    if (matched === 0) {
      level = 'red'
      checks.constraints = 'fail'
      reasons.push(`固定的 ${state.pins.length} 条不可动约束一条都没有被复述`)
    } else if (matched < state.pins.length) {
      level = bump(level, 'yellow')
      checks.constraints = 'warn'
      reasons.push(`固定约束只复述了 ${matched}/${state.pins.length} 条`)
    } else {
      checks.constraints = 'pass'
    }
  } else if (report.constraints.length === 0) {
    // "无" is a legitimate answer when nothing is pinned; only note it.
    checks.constraints = 'pass'
    notes.push('报告没有列出约束（若确实没有不可动约束则正常）')
  } else {
    checks.constraints = 'pass'
  }

  if (actualPaths.length >= 3 && reportPaths.length === 0) {
    const fatal = actualPaths.length >= MISSING_COUNT_RED
    level = fatal ? 'red' : bump(level, 'yellow')
    checks.files = fatal ? 'fail' : 'warn'
    reasons.push(
      fatal
        ? `本会话实际写入 ${actualPaths.length} 个文件，报告一个都没有列出：文件记忆已失效，按交接处理`
        : `本会话实际写入 ${actualPaths.length} 个文件，报告一个都没有列出`,
    )
  } else if (missing.length > 0) {
    const missingRatio = missing.length / actualPaths.length
    if (missing.length >= MISSING_COUNT_RED && missingRatio > MISSING_RATIO_RED) {
      level = 'red'
      checks.files = 'fail'
      reasons.push(
        `漏报 ${missing.length}/${actualPaths.length} 个已写文件（${Math.round(missingRatio * 100)}%）：文件记忆基本失效，按交接处理`,
      )
    } else if (missing.length >= MISSING_COUNT_YELLOW && missingRatio > MISSING_RATIO_YELLOW) {
      level = bump(level, 'yellow')
      checks.files = 'warn'
      reasons.push(`漏报 ${missing.length}/${actualPaths.length} 个已写文件（超过一半）：${missing.slice(0, 3).map((path) => displayPath(state.cwd, path)).join('、')}`)
    } else {
      if (checks.files === 'n/a') checks.files = 'pass'
      notes.push(`报告漏了 ${missing.length} 个文件（少量，不降级）：${missing.slice(0, 3).map((path) => displayPath(state.cwd, path)).join('、')}`)
    }
  } else if (actualPaths.length > 0) {
    checks.files = 'pass'
  }

  if (phantom.length > 0) {
    const phantomRatio = reportPaths.length > 0 ? phantom.length / reportPaths.length : 1
    if (phantom.length >= 3 && phantomRatio > 0.5) {
      level = bump(level, 'yellow')
      if (checks.files === 'pass' || checks.files === 'n/a') checks.files = 'warn'
      reasons.push(`报告里 ${phantom.length} 个文件不在原生写入记录里且占比过高（可能是编造）：${phantom.slice(0, 3).map((path) => displayPath(state.cwd, path)).join('、')}`)
    } else {
      notes.push(`报告里 ${phantom.length} 个文件不在原生写入记录里（多为 shell 写入，不降级）`)
    }
  }

  const unreasoned = report.files.filter((entry) => entry.reason.trim().length < 4)
  if (unreasoned.length > 0) notes.push(`${unreasoned.length} 个文件的修改原因过短`)

  const uncertainConstraints = report.constraints.filter((entry) => entry.certain === false)
  if (uncertainConstraints.length > 0) notes.push(`${uncertainConstraints.length} 条约束被模型标为“不确定”`)

  const constraintUnknown = report.unknowns.some((entry) => /约束|规则|限制|要求|constraint|rule|requirement/i.test(entry))
  const vagueUnknown = report.unknowns.some((entry) =>
    /无法确认|记不清|不记得|不能确认|cannot recall|not sure|unsure/i.test(entry),
  )
  if (constraintUnknown || (vagueUnknown && report.constraints.length === 0)) {
    level = 'red'
    checks.constraints = checks.constraints === 'pass' ? 'warn' : checks.constraints
    reasons.push('模型承认记不清约束/规则')
  } else if (report.unknowns.length > 0) {
    notes.push(`模型列出了 ${report.unknowns.length} 个不确定项（诚实说明，不降级）`)
  }

  if (report.nextStep.trim().length === 0) {
    level = bump(level, 'yellow')
    checks.next = 'warn'
    reasons.push('没有给出下一步')
  } else if (report.verify.length === 0) {
    level = bump(level, 'yellow')
    checks.next = 'warn'
    reasons.push('没有给出验证命令')
  } else {
    const executable = report.verify.some((command) => command.length >= 3 && /[\s/\\\-.]/.test(command))
    if (!executable) {
      level = bump(level, 'yellow')
      checks.next = 'warn'
      reasons.push('验证命令看起来不具体，无法直接执行')
    } else {
      checks.next = 'pass'
    }
  }

  if (report.verdict === 'red' && level !== 'red') {
    level = 'red'
    reasons.push('模型自评 red')
  } else if (report.verdict === 'green' && level !== 'green') {
    reasons.push(`模型自评 green，但证据不支持（证据评估 ${level.toUpperCase()}）`)
  }

  return {
    level,
    reasons: dedupe([...reasons, ...notes]).slice(0, 8),
    checks,
    counts: {
      actualFiles: actualPaths.length,
      reportedFiles: reportPaths.length,
      missing: missing.length,
      phantom: phantom.length,
      pins: state.pins.length,
      pinsMatched:
        state.pins.length === 0
          ? 0
          : state.pins.filter((pin) => matchesPin(pin.text, reportConstraintTexts)).length,
    },
    comparedAt: numberOr(report.at, state.updatedAt),
  }
}

function dedupe(list) {
  return [...new Set(list)]
}

/** Effective verdict, or null when no current (non-stale) verdict exists. */
export function effectiveVerdict(state) {
  const latestCompactionSeq = state.lastCompaction?.seq ?? null
  const reportCurrent =
    state.report !== null &&
    (latestCompactionSeq === null || state.report.forCompactionSeq === latestCompactionSeq) &&
    state.report.assessment !== null
  const reportLevel = reportCurrent ? state.report.assessment.level : null
  const reportAt = reportCurrent ? state.report.at : 0
  const userAt = state.userVerdict?.at ?? 0
  if (state.userVerdict !== null && (!reportCurrent || userAt >= reportAt)) {
    return {
      level: state.userVerdict.level,
      source: 'user',
      reason: state.userVerdict.reason,
      at: state.userVerdict.at,
    }
  }
  if (reportCurrent && reportLevel !== null) {
    return {
      level: reportLevel,
      source: 'report',
      reason: state.report.assessment.reasons[0] ?? '',
      at: reportAt,
    }
  }
  return null
}

/** Advice text for one verdict level. */
export function adviceFor(level) {
  if (level === 'green') return '🟢 可继续，甚至可以扩范围。'
  if (level === 'yellow') return '🟡 只允许把当前子目标做完，不要再扩范围。'
  if (level === 'red') return '🔴 立即交接：输入框上方的弹窗点「写交接单」；没看到就 /guard show 或 /guard handoff。'
  return '⚪ 还没有可判定的行为测试结果。'
}

function headlineFor(state, effective) {
  if (state.probe.status === 'due') return '⏳ 自检待运行'
  if (state.probe.status === 'queued') return '⏳ 自检进行中'
  if (state.probe.status === 'skipped') return '⚠️ 自检被打断'
  if (effective?.level === 'green') return '🟢 可继续'
  if (effective?.level === 'yellow') return '🟡 只做当前子目标'
  if (effective?.level === 'red') return '🔴 立即交接'
  if (state.probe.status === 'answered') return '🔎 已回答，待判定'
  if (state.lastCompaction?.failed) return '⚠️ 上次压缩失败'
  return '⚪ 尚无自检'
}

function adviceText(state, effective) {
  if (effective !== null) return adviceFor(effective.level)
  if (state.probe.status === 'due') return '先运行 /guard check 做三项行为测试；不要只看压缩次数。'
  if (state.probe.status === 'queued') return '等模型完成自检；回答结束后插件会核对证据。'
  if (state.probe.status === 'skipped') return '自检被新消息打断；重新运行 /guard check。'
  if (state.probe.status === 'answered') return '没有可自动核对的报告；请人工判定：/guard green|yellow|red。'
  return adviceFor(null)
}

/** Build the client-visible view from host state. */
export function buildView(state) {
  const effective = effectiveVerdict(state)
  const report = state.report
  const reportCurrent =
    report !== null &&
    (state.lastCompaction === null || report.forCompactionSeq === state.lastCompaction.seq)
  return {
    v: STATE_VERSION,
    updatedAt: state.updatedAt,
    cwd: state.cwd,
    compactions: state.compactions,
    lastCompaction: state.lastCompaction,
    dockEpoch: numberOr(state.dockEpoch, 0),
    probe: {
      status: state.probe.status,
      forCompactionSeq: state.probe.forCompactionSeq,
      promptSeq: state.probe.promptSeq,
      promptAt: state.probe.promptAt,
      answerSeq: state.probe.answerSeq,
      answerAt: state.probe.answerAt,
      answeredForCompactionSeq: state.probe.answeredForCompactionSeq,
      requestedBy: state.probe.requestedBy,
    },
    effective,
    headline: headlineFor(state, effective),
    advice: adviceText(state, effective),
    report: report === null
      ? null
      : {
          verdict: report.verdict,
          at: report.at,
          forCompactionSeq: report.forCompactionSeq,
          current: reportCurrent,
          assessment: report.assessment,
          constraints: report.constraints.slice(0, 12),
          files: report.files.slice(0, 20),
          nextStep: report.nextStep,
          verify: report.verify,
          unknowns: report.unknowns,
          spotCheckFile: report.spotCheckFile,
        },
    pins: state.pins.slice(-10),
    files: state.files.slice(0, 20).map((entry) => ({
      path: displayPath(state.cwd, entry.abs),
      writes: entry.writes,
      added: entry.added,
      removed: entry.removed,
      lastAt: entry.lastAt,
    })),
    request: state.request,
  }
}

/**
 * Build the one prompt that runs the three behavioral tests.
 * It deliberately contains no answer material, only the questions.
 */
export function buildProbePrompt(reason = 'auto') {
  const trigger = reason === 'manual'
    ? '用户现在手动触发一次上下文自检。'
    : '本会话刚刚完成一次上下文压缩。'
  return `${PROBE_MARKER}${reason}]]

🔔 自动上下文自检（${trigger}）

请只凭你当前上下文回答，不要调用 read/grep/glob/shell/git 等任何工具来补答案。唯一允许的是直接回答。如果记不清，明确写“无法确认”；禁止猜测、禁止编造。

请严格分成 A/B/C 三段：

A. 不可动约束：逐条列出当前仍然有效的硬约束（用户明确要求、项目规则、接口/环境限制），每条注明来源（用户消息 / 文件 / 系统）。没有就写“无”。
B. 已改文件：逐条列出本会话中实际改过的文件路径，并写清“改了什么 + 为什么改”。只列真正改过的文件，不要列只读过的。然后挑其中一处，引用你记得的当前关键行。
C. 下一步：写出下一步动作和可直接执行的验证命令（完整命令），并说明现在能否执行。

最后另起一行输出机器可读报告，必须是一个 JSON 对象：
DSH_GUARD_JSON: {"verdict":"green|yellow|red","objective":"一句话：这次要完成什么（含验收标准）","constraints":[{"text":"...","source":"...","certain":true}],"files":[{"path":"...","change":"...","reason":"...","certain":true}],"done":["已完成并通过验证的事"],"verified":[{"command":"跑过的命令","result":"通过/失败/关键输出"}],"decisions":[{"decision":"做了什么选择","reason":"为什么","rejected":false}],"failedAttempts":["试过但失败的做法与原因"],"nextStep":"...","verify":["..."],"unknowns":["..."],"spotCheckFile":"..."}

objective / done / verified / decisions / failedAttempts 是可选字段，但交接单会直接用到：能回忆多少写多少，记不清就写“无法确认”，不要编造。

判定标准：
- green：三项齐全，细节到文件/命令级。
- yellow：约束对，但文件或原因开始模糊。
- red：约束复述错误、开始编造文件、或给不出下一步。
`
}

/** Short model-facing advice injected after a user verdict. */
export function buildAdviceMessage(level) {
  return `${ADVICE_MARKER}
上下文交接哨兵判定：${adviceFor(level)}
不要继续扩大工作范围；如果判定为 red，先停止新工作，输出交接单所需信息并提醒用户新开对话。`
}

/** Human-readable summary of a guard state for `/guard status`. */
/** Flatten one activation output (content blocks, messages, or plain text) into plain text. */
export function textFromOutput(output) {
  if (typeof output === 'string') return output
  if (!Array.isArray(output)) return ''
  const parts = []
  for (const block of output) {
    if (!isObject(block)) continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (Array.isArray(block.content)) parts.push(textFromOutput(block.content))
  }
  return parts.filter((part) => part.length > 0).join('\n')
}

/** Short human label for one verdict level. */
export function verdictLabel(level) {
  if (level === 'green') return '🟢 GREEN'
  if (level === 'red') return '🔴 RED'
  if (level === 'yellow') return '🟡 YELLOW'
  return '⚪ 未知'
}

/**
 * Render the human-facing account of one finished background self-check.
 *
 * The probe answer stays in the fork child's own session, so the only thing
 * that reaches the parent conversation is this verdict: no A/B/C dump, no
 * machine JSON, just the level plus the evidence that moved it.
 */
export function buildVerdictNotice(report, assessment) {
  const level = assessment?.level ?? report?.verdict ?? 'yellow'
  const label = verdictLabel(level)
  const reasons = Array.isArray(assessment?.reasons) ? assessment.reasons : []
  const counts = assessment?.counts
  const headline = [`交接哨兵 ${label}`, reasons[0]]
    .filter((part) => typeof part === 'string' && part.trim().length > 0)
    .join(' · ')
    .slice(0, 120)
  const lines = [`交接哨兵 · 后台自检完成：${label}`]
  if (reasons.length > 0) lines.push(`理由：${reasons.slice(0, 3).join('；')}`)
  if (isObject(counts)) {
    lines.push(
      `证据：实际写入 ${numberOr(counts.actualFiles, 0)} · 报告 ${numberOr(counts.reportedFiles, 0)} · 漏报 ${numberOr(counts.missing, 0)} · 未记录 ${numberOr(counts.phantom, 0)}`,
    )
  }
  if (level === 'red') {
    lines.push('')
    lines.push('输入框上方会弹出「写交接单 / 稍后」确认；没看到就输入 `/guard show` 让哨兵条出现，或直接 `/guard handoff`。')
    lines.push('（系统通知：这条是哨兵自动写入的状态记录，不需要执行任何操作，也不要自行开始写交接单；用户会在输入框上方看到按钮。继续原任务即可。）')
  }
  return { level, label, summary: headline.length > 0 ? headline : `交接哨兵 ${label}`, text: lines.join('\n') }
}

export function buildStatusText(state) {
  const effective = effectiveVerdict(state)
  const lines = ['上下文交接哨兵']
  lines.push(`- 判定：${effective === null ? '尚无' : `${effective.level.toUpperCase()}（来源：${effective.source}）`}`)
  lines.push(`- 建议：${adviceFor(effective?.level ?? null)}`)
  if (state.lastCompaction === null) {
    lines.push('- 压缩记录：无')
  } else {
    const compaction = state.lastCompaction
    const tokens = typeof compaction.shadowedTokens === 'number' ? `，回收 ≈${compaction.shadowedTokens} tokens` : ''
    lines.push(`- 最近压缩：#${state.compactions} 于 ${formatTime(compaction.time)}${tokens}${compaction.failed ? '（失败）' : ''}`)
  }
  if (state.request !== null) {
    const window = typeof state.request.contextWindow === 'number' ? ` / 窗口 ${state.request.contextWindow}` : ''
    lines.push(`- 模型：${state.request.provider ?? '?'}/${state.request.model ?? '?'}${window}`)
  }
  lines.push(`- 自检状态：${state.probe.status}`)
  if (state.pins.length > 0) lines.push(`- 固定约束：${state.pins.length} 条`)
  if (state.files.length > 0) lines.push(`- 实际写入文件：${state.files.length} 个`)
  if (state.report !== null) {
    const stale = state.lastCompaction !== null && state.report.forCompactionSeq !== state.lastCompaction.seq
    const assessed = state.report.assessment !== null ? state.report.assessment.level : state.report.verdict
    const selfVerdict = assessed !== state.report.verdict ? `；模型自评 ${state.report.verdict}` : ''
    lines.push(`- 最近报告：评估 ${assessed.toUpperCase()}${selfVerdict}（${stale ? '已过期' : '当前'}）`)
    if (state.report.assessment !== null && state.report.assessment.reasons.length > 0) {
      for (const reason of state.report.assessment.reasons.slice(0, 4)) lines.push(`  - ${reason}`)
    }
  }
  lines.push('')
  lines.push('命令：/guard check | /guard green|yellow|red [原因] | /guard handoff | /guard pin <约束> | /guard reset')
  return lines.join('\n')
}

function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '未知时间'
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return new Date(ms).toISOString()
  }
}

/**
 * The prompt that makes the model write the handoff itself.
 *
 * A plugin can only see deterministic state (files, report, pins). The parts
 * that make a handoff useful — why a plan was rejected, what was tried and
 * failed, how "done" was verified — exist only in the model's context. So the
 * plugin asks the model to write the document, with the framework and the
 * deterministic data as supporting material, instead of writing a sparse file.
 */
export function buildHandoffInstruction(state, { draftPath = '' } = {}) {
  const effective = effectiveVerdict(state)
  const report = state.report
  const lines = []
  lines.push('[[DSH-CONTEXT-GUARD:HANDOFF]]')
  lines.push('')
  lines.push('用户已确认要写交接单。请**基于你当前上下文**（不要读取/搜索历史会话日志来补内容，凭回忆写；记不清就写“无法确认”）写一份完整的交接文档。')
  lines.push('')
  lines.push('先在心里逐项回忆本会话，再一次性写成 Markdown 文件。文档开头先写一段「用途：新对话冷启动」和「当前最重要的事实」，然后是下面全部章节，不允许用“未提供/待补充”占位：')
  lines.push('')
  lines.push('1. **任务来源与授权边界**：用户的大目标；明确授权过哪些操作；明确未授权/禁止的事项（尤其是外部操作、发布、改配置）。')
  lines.push('2. **目标与完成标准（可验收）**：这次任务要交付什么，怎样算完成（写可执行的验收条件，不写“继续优化”）。')
  lines.push('3. **进度盘点**：用表格「大项 | 当前状态 | 可核验依据」逐项列出，状态必须对应真实文件/命令输出；已完成的写依据，没完成的写卡点。')
  lines.push('4. **关键决策与理由**：做过哪些选择、为什么；尤其**被否决的方案**和否决原因，防止新对话重踩。')
  lines.push('5. **涉及文件清单**：每个改动文件的路径 + 改了什么 + 为什么改；按源码/文档/脚本/产出物分组。')
  lines.push('6. **已知坑与失败尝试**：试过但失败的做法、踩过的坑、环境陷阱。')
  lines.push('7. **当前卡点与未完成项**：现在卡在哪、缺什么、哪些是用户尚未授权的。')
  lines.push('8. **下一步**：3–5 条具体动作，按优先级排序。')
  lines.push('9. **约束**：不能动的部分、代码风格、环境限制、用户明确要求。')
  lines.push('10. **复跑命令与结果**：交接前复跑过的命令和输出（通过/失败数），以及新对话第一步应该跑什么。')
  lines.push('')
  lines.push('写作要求：')
  lines.push('- 具体到路径、命令、行号级细节；不要写泛泛而谈的总结。')
  lines.push('- 只写你确实记得的；记不清的明确标注“无法确认”，禁止编造。')
  lines.push('- 结论必须能被文件或命令复核；不能复核的写成“口头/未验证”。')
  lines.push('- 用中文写；代码/命令保持原样。')
  lines.push('')
  if (state.pins.length > 0) {
    lines.push('用户固定的不可动约束（必须原样继承）：')
    for (const pin of state.pins) lines.push(`- ${pin.text}`)
    lines.push('')
  }
  if (report !== null && report.constraints.length > 0) {
    lines.push('自检报告里的约束（可核对）：')
    for (const constraint of report.constraints) {
      lines.push(`- ${constraint.text}${constraint.source.length > 0 ? `（来源：${constraint.source}）` : ''}`)
    }
    lines.push('')
  }
  if (state.files.length > 0) {
    lines.push(`原生写入工具记录（共 ${state.files.length} 个文件，供你核对清单）：`)
    for (const file of state.files.slice(0, 80)) lines.push(`- \`${displayPath(state.cwd, file.abs)}\`（写 ${file.writes} 次）`)
    if (state.files.length > 80) lines.push(`- …另有 ${state.files.length - 80} 个`)
    lines.push('')
  }
  if (report !== null && report.verify.length > 0) {
    lines.push('本会话用过的验证命令：')
    for (const command of report.verify) lines.push(`- \`${command}\``)
    lines.push('')
  }
  lines.push(`把文件写到工作目录的 \`${draftPath || '.dsh-handoff/HANDOFF-<日期>.md'}\`（用 write 工具，目录不存在就创建）。`)
  lines.push('写完后只回复：文件路径 + 三句话以内的摘要。不要把整篇文档粘贴回对话。')
  if (effective !== null) {
    lines.push('')
    lines.push(`（哨兵判定：${effective.level.toUpperCase()}；本次为人工确认后的交接。）`)
  }
  return lines.join('\n')
}

/**
 * Build the handoff brief. Pure; the host command / tool writes it to disk.
 *
 * Seven sections the next agent actually needs: objective + acceptance,
 * current state with verified evidence, decisions (including rejected ones),
 * changed files with reasons, known traps and failed attempts, 3-5 concrete
 * next steps, and the constraints that must not move. `extra` lets the model
 * fill the parts only it remembers when it opts into a handoff.
 *
 * @param {object} options
 * @param {object} options.state - guard projection state
 * @param {string} options.sessionId
 * @param {{totalTokens?: number, surfaceTokens?: number}|null} [options.measurement]
 * @param {object|null} [options.pressure]
 * @param {(abs: string) => boolean} [options.fileExists]
 * @param {object|null} [options.extra] - model-supplied sections
 */
export function buildHandoffMarkdown({ state, sessionId, measurement = null, pressure = null, fileExists = null, extra = null }) {
  const effective = effectiveVerdict(state)
  const compaction = state.lastCompaction
  const report = state.report
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  const lines = []
  const fill = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)
  const pickList = (override, fallback) => {
    const source = Array.isArray(override) && override.length > 0 ? override : fallback
    return Array.isArray(source) ? source : []
  }
  const objective = fill(extra?.objective) ?? (report === null ? null : fill(report.objective))
  const done = pickList(extra?.done, report === null ? [] : report.done).filter((item) => typeof item === 'string' && item.trim().length > 0)
  const verified = pickList(extra?.verified, report === null ? [] : report.verified)
  const decisions = pickList(extra?.decisions, report === null ? [] : report.decisions)
  const failed = pickList(extra?.failedAttempts, report === null ? [] : report.failedAttempts).filter((item) => typeof item === 'string' && item.trim().length > 0)
  const nextSteps = pickList(extra?.nextSteps, []).filter((item) => typeof item === 'string' && item.trim().length > 0)
  const acceptance = pickList(extra?.acceptance, []).filter((item) => typeof item === 'string' && item.trim().length > 0)
  const extraConstraints = pickList(extra?.constraints, []).filter((item) => typeof item === 'string' && item.trim().length > 0)
  const reportConstraints = report === null ? [] : report.constraints
  const nextStep = fill(report?.nextStep)

  lines.push('# 上下文交接单')
  lines.push('')
  lines.push(`- 会话：\`${sessionId}\``)
  lines.push(`- 生成：${now}`)
  if (state.request !== null) {
    const window = typeof state.request.contextWindow === 'number' ? ` / 窗口 ${state.request.contextWindow}` : ''
    lines.push(`- 模型：${state.request.provider ?? '?'}/${state.request.model ?? '?'}${window}`)
  }
  if (compaction !== null) {
    const tokens = typeof compaction.shadowedTokens === 'number' ? `，回收 ≈${compaction.shadowedTokens} tokens` : ''
    lines.push(`- 压缩次数：${state.compactions}；最近一次 ${formatTime(compaction.time)}${tokens}`)
  }
  if (measurement !== null && typeof measurement.totalTokens === 'number') {
    lines.push(`- 当前计量：total≈${measurement.totalTokens} tokens`)
  }
  if (pressure !== null && typeof pressure.projectedTokens === 'number') {
    lines.push(`- 下一请求预估：${pressure.projectedTokens} tokens`)
  }
  lines.push(`- 判定：${effective === null ? '尚无行为测试结论' : `${effective.level.toUpperCase()}（来源：${effective.source}）`}`)
  if (report !== null && report.assessment !== null && report.assessment.reasons.length > 0) {
    lines.push('- 判定依据：')
    for (const reason of report.assessment.reasons.slice(0, 6)) lines.push(`  - ${reason}`)
  }
  if (state.userVerdict !== null && state.userVerdict.reason.length > 0) {
    lines.push(`- 人工备注：${state.userVerdict.reason}`)
  }
  lines.push('')

  lines.push('## 1. 目标与完成标准（可验收）')
  lines.push('')
  lines.push(objective ?? '⚠️ 未提供。新对话必须先向用户确认目标，不要自行推断。')
  if (acceptance.length > 0) {
    lines.push('')
    lines.push('验收标准：')
    for (const item of acceptance) lines.push(`- ${item}`)
  } else if (report !== null && report.verify.length > 0) {
    lines.push('')
    lines.push('验收标准（可执行）：')
    lines.push('```sh')
    for (const command of report.verify) lines.push(command)
    lines.push('```')
  } else {
    lines.push('')
    lines.push('⚠️ 未提供验收标准；补上可执行的验证命令后再交付。')
  }
  lines.push('')

  lines.push('## 2. 当前状态')
  lines.push('')
  lines.push('### 已完成')
  if (done.length === 0) lines.push('- （模型未提供；请对照文件清单与 git 状态补全）')
  else for (const item of done) lines.push(`- ${item}`)
  lines.push('')
  lines.push('### 已验证')
  if (verified.length === 0 && (report === null || report.verify.length === 0)) {
    lines.push('- （没有记录验证结果；交接前至少跑一遍验证命令）')
  } else if (verified.length === 0) {
    lines.push('- 只有验证命令、没有结果记录：交接后必须先跑一遍再开始改动。')
  } else {
    for (const entry of verified) {
      if (typeof entry === 'string') lines.push(`- ✅ ${entry}`)
      else {
        const command = typeof entry.command === 'string' ? entry.command : ''
        const result = typeof entry.result === 'string' ? entry.result : ''
        lines.push(`- \`${command}\`${result.length > 0 ? ` → ${result}` : ''}`)
      }
    }
  }
  if (report !== null && report.assessment !== null) {
    const counts = report.assessment.counts
    lines.push('')
    lines.push(`### 证据摘要`)
    lines.push(`- 原生写入记录 ${counts.actualFiles} 个文件；自检报告列出 ${counts.reportedFiles} 个；漏报 ${counts.missing} 个；未记录 ${counts.phantom} 个。`)
  }
  lines.push('')

  lines.push('## 3. 关键决策与理由（含被否决方案）')
  lines.push('')
  if (decisions.length === 0) {
    lines.push('- （模型未提供。新对话不要重新讨论已定方案；如需变更，先问用户。）')
  } else {
    for (const entry of decisions) {
      if (typeof entry === 'string') lines.push(`- ${entry}`)
      else {
        const decision = typeof entry.decision === 'string' ? entry.decision : ''
        const reason = typeof entry.reason === 'string' ? entry.reason : ''
        const rejected = entry.rejected === true
        lines.push(`- ${rejected ? '❌ 已否决：' : '✅ '}${decision}${reason.length > 0 ? ` —— 理由：${reason}` : ''}`)
      }
    }
  }
  lines.push('')

  lines.push('## 4. 涉及文件清单（路径 + 改了什么 + 为什么）')
  lines.push('')
  if (report === null) {
    lines.push('- （没有结构化自检报告；以下只有原生写入记录，改动原因需人工补全）')
  } else if (report.files.length === 0) {
    lines.push('- ⚠️ 自检报告没有列出任何文件，但本会话有原生写入记录（见下）。先运行 `/guard check` 重新核对。')
  } else {
    for (const file of report.files) {
      const abs = normalizePath(state.cwd, file.path)
      const exists = abs !== null && fileExists !== null ? fileExists(abs) : null
      const existence = exists === true ? '' : exists === false ? '；⚠️ 磁盘上不存在' : ''
      lines.push(`- \`${file.path}\` — ${file.change || '（未说明改动）'}；原因：${file.reason || '（未说明原因）'}${existence}`)
    }
  }
  if (state.files.length > 0) {
    lines.push('')
    lines.push(`原生写入工具记录（${state.files.length} 个）：`)
    lines.push('')
    lines.push('| 文件 | 写次数 | +行 | −行 |')
    lines.push('| --- | --- | --- | --- |')
    for (const file of state.files.slice(0, 40)) {
      lines.push(`| \`${displayPath(state.cwd, file.abs)}\` | ${file.writes} | ${file.added} | ${file.removed} |`)
    }
    if (state.files.length > 40) lines.push('')
    if (state.files.length > 40) lines.push(`- （还有 ${state.files.length - 40} 个文件未列出）`)
  }
  lines.push('')

  lines.push('## 5. 已知坑与失败尝试')
  lines.push('')
  if (failed.length === 0) lines.push('- （模型未提供失败尝试；最容易被漏掉，新对话不要盲目重试旧方案。）')
  else for (const item of failed) lines.push(`- ⚠️ ${item}`)
  if (report !== null && report.unknowns.length > 0) {
    lines.push('')
    lines.push('不确定项：')
    for (const unknown of report.unknowns) lines.push(`- ${unknown}`)
  }
  lines.push('')

  lines.push('## 6. 下一步（3–5 条具体动作）')
  lines.push('')
  const steps = nextSteps.length > 0 ? nextSteps : nextStep !== null ? [nextStep] : []
  if (steps.length === 0) lines.push('- ⚠️ 未提供。新对话必须先问用户下一步做什么。')
  else steps.slice(0, 5).forEach((step, index) => lines.push(`${index + 1}. ${step}`))
  lines.push('')
  if (report !== null && report.verify.length > 0) {
    lines.push('验证命令：')
    lines.push('```sh')
    for (const command of report.verify) lines.push(command)
    lines.push('```')
    lines.push('')
  }

  lines.push('## 7. 约束（不能动的部分、风格、环境限制）')
  lines.push('')
  if (state.pins.length === 0 && reportConstraints.length === 0 && extraConstraints.length === 0) {
    lines.push('- ⚠️ 没有固定约束，也没有自检报告。交接前请用 `/guard pin <约束>` 补充。')
  } else {
    state.pins.forEach((pin, index) => lines.push(`${index + 1}. **[固定]** ${pin.text}`))
    for (const constraint of reportConstraints) {
      const source = constraint.source.length > 0 ? `（来源：${constraint.source}）` : ''
      lines.push(`- ${constraint.text}${source}${constraint.certain === false ? ' ⚠️ 模型不确定' : ''}`)
    }
    for (const constraint of extraConstraints) lines.push(`- ${constraint}`)
  }
  lines.push('')

  lines.push('## 新对话开场白')
  lines.push('')
  lines.push('把下面这段作为新对话的第一条消息（或直接让新对话读这份文件）：')
  lines.push('')
  lines.push('---')
  lines.push('这是一次交接。请先读这份交接单，然后：')
  lines.push('1. 复述你理解的目标、约束和下一步；')
  lines.push('2. 对照文件清单确认当前状态（以磁盘和 git 为准，不要只信文档）；')
  lines.push('3. 复述完再开始动手；发现冲突先问我。')
  lines.push('')
  lines.push(`目标：${objective ?? '（见交接单，待确认）'}`)
  lines.push('')
  lines.push('不可动约束：')
  if (state.pins.length > 0) state.pins.forEach((pin) => lines.push(`- ${pin.text}`))
  reportConstraints.forEach((constraint) => lines.push(`- ${constraint.text}`))
  extraConstraints.forEach((constraint) => lines.push(`- ${constraint}`))
  if (state.pins.length === 0 && reportConstraints.length === 0 && extraConstraints.length === 0) lines.push('- （待补充）')
  lines.push('')
  lines.push('下一步：')
  if (steps.length === 0) lines.push('- （待补充）')
  else steps.slice(0, 5).forEach((step, index) => lines.push(`${index + 1}. ${step}`))
  lines.push('---')
  lines.push('')

  return lines.join('\n')
}

/** Extract the first line of a user message for diagnostics. */
export function previewText(value, max = 200) {
  const text = stringOr(value)
  return text.length <= max ? text : `${text.slice(0, max)}…`
}
