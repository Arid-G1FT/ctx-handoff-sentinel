/**
 * dsh-context-guard — browser half.
 *
 * A slim dock above the composer that shows the behavioral verdict and the two
 * commands that matter. The model-facing probe and all evidence checks live in
 * the host half; this file only renders the projection and copies commands.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-context-guard',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { useState } = React

    const CSS = `
.dcg_dock{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));margin:0 auto;font-size:13px;line-height:20px}
.dcg_bar{isolation:isolate;box-sizing:border-box;display:flex;align-items:center;gap:9px;width:100%;max-width:calc(var(--dsh-composer-card-max-width,760px) - 4 * var(--dsh-composer-dock-inset,0px));margin:0 auto;padding:6px 7px 6px 11px;border-radius:var(--dsw-radius-md,10px);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.10));box-shadow:var(--dsw-elevation-panel,0 6px 20px rgba(0,0,0,.22));position:relative;color:var(--dsw-alias-label-primary,#e6edf3);background:var(--dsw-specific-menu,#161b22)}
.dcg_dot{width:8px;height:8px;border-radius:999px;flex:none;background:#8b949e;box-shadow:0 0 0 3px rgba(139,148,158,.12)}
.dcg_title{flex:none;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#b7c3d0);white-space:nowrap}
.dcg_status{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#e6edf3)}
.dcg_actions{flex:none;display:flex;align-items:center;gap:6px}
.dcg_btn{corner-shape:round;display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#b7c3d0);font-size:11px;line-height:20px;cursor:pointer;font-family:inherit;white-space:nowrap}
.dcg_btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.07));color:var(--dsw-alias-label-primary,#e6edf3)}
.dcg_btn_primary{color:#e6edf3;border-color:var(--dsw-alias-border-l1,rgba(255,255,255,.18));background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.05))}
.dcg_chip{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:10px;padding:1px 5px;border-radius:5px;background:rgba(110,118,129,.16);color:var(--dsw-alias-label-secondary,#b7c3d0);white-space:nowrap}
.dcg_details{margin-top:6px;max-width:calc(var(--dsh-composer-card-max-width,760px) - 4 * var(--dsh-composer-dock-inset,0px));margin-left:auto;margin-right:auto;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.10));border-radius:var(--dsw-radius-md,10px);background:var(--dsw-specific-menu,#161b22);color:var(--dsw-alias-label-primary,#e6edf3);padding:10px 12px;font-size:12px;line-height:1.65;max-height:340px;overflow:auto}
.dcg_section{margin:0 0 8px 0}
.dcg_section:last-child{margin-bottom:0}
.dcg_h{font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary,#b7c3d0);margin-bottom:2px}
.dcg_list{margin:0;padding-left:18px}
.dcg_list li{margin:1px 0}
.dcg_warn{color:#d29922}
.dcg_bad{color:#f85149}
.dcg_ok{color:#2ea043}
.dcg_muted{color:var(--dsw-alias-label-tertiary,#8b949e)}
.dcg_code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11px;background:rgba(110,118,129,.16);padding:1px 4px;border-radius:4px}
.dcg_pre{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Consolas,monospace);font-size:11px;white-space:pre-wrap;word-break:break-word;background:rgba(110,118,129,.10);border-radius:6px;padding:6px 8px;margin:2px 0 0 0;max-height:130px;overflow:auto}
.dcg_close{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:14px;line-height:1;cursor:pointer;font-family:inherit}
.dcg_close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-primary,#e6edf3)}
.dcg_offer{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-side-clearance,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px) - var(--dsh-composer-dock-inset,0px));max-width:calc(var(--dsh-composer-card-max-width,760px) - 4 * var(--dsh-composer-dock-inset,0px));margin:0 auto 6px auto;display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:var(--dsw-radius-md,10px);border:1px solid rgba(248,81,73,.45);background:var(--dsw-specific-menu,#161b22);box-shadow:var(--dsw-elevation-panel,0 6px 20px rgba(0,0,0,.22))}
.dcg_offer_text{flex:1;min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#e6edf3)}
.dcg_offer_meta{display:block;margin-top:2px;color:var(--dsw-alias-label-tertiary,#8b949e);font-size:11px}
.dcg_offer_actions{flex:none;display:flex;align-items:center;gap:8px}
.dcg_offer_done{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width,760px) - 4 * var(--dsh-composer-dock-inset,0px));margin:0 auto 6px auto;padding:6px 10px;border-radius:8px;color:var(--dsw-alias-label-secondary,#b7c3d0);font-size:12px;background:rgba(110,118,129,.12)}
`

    const TAG_ID = '@local/dsh-context-guard/dock.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@local/dsh-context-guard'
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const COLORS = {
      green: '#2ea043',
      yellow: '#d29922',
      red: '#f85149',
      blue: '#58a6ff',
      gray: '#8b949e',
    }

    /**
     * Persisted dock visibility.
     *
     * Closing the dock hides it completely — no pill, no placeholder — but the
     * host keeps running background self-checks. The stored value is the
     * `dockEpoch` the user closed at; `/guard show` bumps that epoch, so the
     * dock comes back without any extra UI surface.
     */
    const HIDDEN_EPOCH_KEY = 'dsh-context-guard.dockHiddenEpoch'

    function readHiddenEpoch() {
      try {
        return window.localStorage.getItem(HIDDEN_EPOCH_KEY)
      } catch (e) {
        return null
      }
    }

    function writeHiddenEpoch(epoch) {
      try {
        window.localStorage.setItem(HIDDEN_EPOCH_KEY, epoch)
      } catch (e) {
        // storage may be unavailable in a sandboxed frame; hiding still applies for this render tree
      }
    }

    /** Host endpoint the red-verdict popup calls (registered by the host half). */
    const HANDOFF_ROUTE = '/api/dsh-context-guard/handoff'
    /** Per-report dismissal: ask once per red verdict, not once per render. */
    const OFFER_DISMISS_PREFIX = 'dsh-context-guard.handoffOffer.'

    function offerKey(sessionId, reportAt) {
      return OFFER_DISMISS_PREFIX + String(sessionId) + '.' + String(reportAt)
    }

    function readDismissed(key) {
      if (!key) return false
      try {
        return window.localStorage.getItem(key) === '1'
      } catch (e) {
        return false
      }
    }

    function writeDismissed(key) {
      if (!key) return
      try {
        window.localStorage.setItem(key, '1')
      } catch (e) {
        // ignore
      }
    }

    async function decideHandoff(sessionId, decision) {
      const response = await fetch(HANDOFF_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, decision }),
      })
      if (!response.ok) {
        let detail = 'HTTP ' + response.status
        try {
          const body = await response.json()
          if (body && typeof body.error === 'string') detail = body.error
        } catch (e) {
          // keep the status
        }
        throw new Error(detail)
      }
      return response.json().catch(() => ({}))
    }

    function toneOf(view) {
      if (view.effective !== null && view.effective !== undefined) return view.effective.level
      if (view.probe.status === 'queued') return 'blue'
      if (view.probe.status === 'due' || view.probe.status === 'skipped') return 'yellow'
      return 'gray'
    }

    function compactNumber(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return ''
      if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M'
      if (value >= 1000) return (value / 1000).toFixed(1) + 'k'
      return String(value)
    }

    function formatTime(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return ''
      try {
        return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
      } catch (e) {
        return ''
      }
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch (e) {
        // fall through to the textarea path
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.left = '-9999px'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch (e) {
        return false
      }
    }

    function statusLine(view) {
      const parts = []
      if (view.lastCompaction && view.lastCompaction.failed !== true) {
        const tokens = compactNumber(view.lastCompaction.shadowedTokens)
        parts.push('压缩 #' + view.compactions + (tokens ? ' · 回收 ≈' + tokens + ' tokens' : ''))
      } else if (view.lastCompaction && view.lastCompaction.failed === true) {
        parts.push('上次压缩失败')
      }
      if (view.probe.status === 'due') parts.push('行为自检待运行')
      else if (view.probe.status === 'queued') parts.push('自检进行中…')
      else if (view.probe.status === 'skipped') parts.push('自检被新消息打断')
      else if (view.probe.status === 'answered' && (view.effective === null || view.effective === undefined)) parts.push('已回答，待人工判定')
      if (view.request && view.request.model) parts.push(view.request.model)
      return parts.length > 0 ? parts.join(' · ') : '尚无自检'
    }

    function VerdictDot(props) {
      return h('span', {
        className: 'dcg_dot',
        style: { background: COLORS[props.tone] || COLORS.gray, boxShadow: '0 0 0 3px ' + (COLORS[props.tone] || COLORS.gray) + '22' },
        'aria-hidden': true,
      })
    }

    function CmdButton(props) {
      const [copied, setCopied] = useState(false)
      const onClick = async () => {
        const ok = await copyText(props.command)
        if (ok) {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        }
      }
      return h('button', {
        type: 'button',
        className: 'dcg_btn' + (props.primary ? ' dcg_btn_primary' : ''),
        title: '复制：' + props.command,
        onClick,
      }, copied ? '已复制' : props.label || props.command)
    }

    function Details(props) {
      const view = props.view
      const report = view.report
      const assessment = report && report.assessment
      const sections = []
      if (view.pins && view.pins.length > 0) {
        sections.push(h('div', { className: 'dcg_section', key: 'pins' },
          h('div', { className: 'dcg_h' }, '固定约束（' + view.pins.length + '）'),
          h('ol', { className: 'dcg_list' }, view.pins.map((pin, i) => h('li', { key: i }, pin.text))),
        ))
      }
      if (assessment) {
        const counts = assessment.counts || {}
        sections.push(h('div', { className: 'dcg_section', key: 'assessment' },
          h('div', { className: 'dcg_h' }, '证据核对'),
          h('div', { className: 'dcg_muted' },
            '实际写入 ' + (counts.actualFiles || 0) + ' · 报告列出 ' + (counts.reportedFiles || 0) +
            ' · 漏报 ' + (counts.missing || 0) + ' · 未记录 ' + (counts.phantom || 0) +
            (counts.pins ? ' · 约束命中 ' + (counts.pinsMatched || 0) + '/' + counts.pins : '')),
          h('ul', { className: 'dcg_list' },
            (assessment.reasons || []).map((reason, i) => h('li', {
              key: i,
              className: assessment.level === 'red' ? 'dcg_bad' : assessment.level === 'yellow' ? 'dcg_warn' : 'dcg_ok',
            }, reason))),
        ))
      }
      if (report) {
        const current = report.current !== false
        sections.push(h('div', { className: 'dcg_section', key: 'report' },
          h('div', { className: 'dcg_h' }, '自检报告' + (current ? '' : '（已过期）')),
          report.constraints && report.constraints.length > 0
            ? h('div', null, h('span', { className: 'dcg_muted' }, '约束：'), report.constraints.map((c, i) => h('div', { key: i }, '· ' + c.text + (c.source ? '（' + c.source + '）' : ''))))
            : null,
          report.files && report.files.length > 0
            ? h('div', null, h('span', { className: 'dcg_muted' }, '文件：'),
                report.files.slice(0, 8).map((f, i) => h('div', { key: i }, '· ' + f.path + ' — ' + (f.change || '改动') + '；' + (f.reason || '无原因'))))
            : null,
          h('div', null, h('span', { className: 'dcg_muted' }, '下一步：'), report.nextStep || '（未给出）'),
          report.verify && report.verify.length > 0
            ? h('div', null, h('span', { className: 'dcg_muted' }, '验证：'),
                report.verify.map((cmd, i) => h('div', { key: i, className: 'dcg_code' }, cmd)))
            : h('div', { className: 'dcg_warn' }, '没有验证命令'),
        ))
      }
      if (view.files && view.files.length > 0) {
        sections.push(h('div', { className: 'dcg_section', key: 'files' },
          h('div', { className: 'dcg_h' }, '原生写入工具记录（' + view.files.length + '）'),
          h('div', null, view.files.slice(0, 8).map((f, i) =>
            h('div', { key: i }, '· ' + f.path + '（写 ' + f.writes + ' 次，+' + f.added + '/−' + f.removed + '）'))),
        ))
      }
      sections.push(h('div', { className: 'dcg_section', key: 'help' },
        h('div', { className: 'dcg_h' }, '命令'),
        h('div', { className: 'dcg_muted' }, '/guard check · /guard green|yellow|red [原因] · /guard handoff · /guard pin <约束> · /guard status'),
      ))
      return h('div', { className: 'dcg_details' }, sections)
    }

    function ContextGuardDock(props) {
      const view = props.useProjection('contextGuard')
      const [open, setOpen] = useState(false)
      const [hiddenEpoch, setHiddenEpoch] = useState(readHiddenEpoch)
      const [offerState, setOfferState] = useState('idle')
      const [offerError, setOfferError] = useState('')
      if (view === undefined || view === null) return null
      // Closed means gone: no pill, no placeholder. `/guard show` bumps
      // `dockEpoch`, which no longer matches the stored value and brings it back.
      const dockEpoch = String(view.dockEpoch === undefined ? 0 : view.dockEpoch)
      if (hiddenEpoch === dockEpoch) return null
      const active =
        view.compactions > 0 ||
        view.lastCompaction !== null ||
        (view.probe && view.probe.status !== 'none') ||
        view.effective !== null ||
        view.report !== null
      if (!active) return null
      const tone = toneOf(view)
      const showCheck = view.probe.status === 'due' || view.probe.status === 'skipped' || (view.probe.status === 'answered' && view.effective === null)
      const showHandoff = view.effective !== null && view.effective.level !== 'green'
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const reportAt = view.report !== null && view.report !== undefined && typeof view.report.at === 'number' ? view.report.at : 0
      const dismissedKey = sessionId ? offerKey(sessionId, reportAt) : ''
      const red =
        view.effective !== null &&
        view.effective !== undefined &&
        view.effective.level === 'red'
      const offerVisible = red && offerState !== 'done' && offerState !== 'dismissed' && !readDismissed(dismissedKey)

      const decide = async (decision) => {
        setOfferError('')
        setOfferState('sending')
        try {
          await decideHandoff(sessionId, decision)
          writeDismissed(dismissedKey)
          setOfferState(decision === 'yes' ? 'done' : 'dismissed')
        } catch (error) {
          setOfferError(String(error && error.message ? error.message : error))
          setOfferState('idle')
        }
      }

      return h('div', { className: 'dcg_dock', 'data-context-guard': true },
        offerVisible
          ? h('div', { className: 'dcg_offer', role: 'dialog', 'aria-label': '是否现在写交接单' },
              h('div', { className: 'dcg_offer_text' },
                '🔴 上下文已经明显不可靠，建议现在交接。',
                h('span', { className: 'dcg_offer_meta' },
                  offerError.length > 0
                    ? '发送失败：' + offerError
                    : '生成一份完整交接单后，新对话读它即可继续，不用重述项目背景。'),
              ),
              h('div', { className: 'dcg_offer_actions' },
                h('button', {
                  type: 'button',
                  className: 'dcg_btn dcg_btn_primary',
                  disabled: offerState === 'sending',
                  onClick: () => decide('yes'),
                }, offerState === 'sending' ? '请求中…' : '写交接单'),
                h('button', {
                  type: 'button',
                  className: 'dcg_btn',
                  disabled: offerState === 'sending',
                  onClick: () => decide('no'),
                }, '稍后'),
              ),
            )
          : null,
        offerState === 'done'
          ? h('div', { className: 'dcg_offer_done' }, '已把写交接单的请求交给模型，完成后会把路径发到对话里。')
          : null,
        h('div', { className: 'dcg_bar', title: view.advice },
          h(VerdictDot, { tone }),
          h('span', { className: 'dcg_title' }, '交接哨兵'),
          h('span', { className: 'dcg_status' }, view.headline + ' · ' + statusLine(view)),
          h('div', { className: 'dcg_actions' },
            showCheck ? h(CmdButton, { command: '/guard check', label: '自检', primary: true }) : null,
            showHandoff ? h(CmdButton, { command: '/guard handoff', label: '交接单', primary: true }) : null,
            h(CmdButton, { command: '/guard status', label: '状态' }),
            h('button', {
              type: 'button',
              className: 'dcg_btn',
              onClick: () => setOpen((value) => !value),
              title: open ? '收起证据' : '展开证据',
            }, open ? '收起' : '详情'),
            h('button', {
              type: 'button',
              className: 'dcg_close',
              title: '关闭哨兵条（后台自检继续；用 /guard show 恢复）',
              'aria-label': '关闭哨兵条',
              onClick: () => {
                writeHiddenEpoch(dockEpoch)
                setHiddenEpoch(dockEpoch)
                setOpen(false)
              },
            }, '×'),
          ),
        ),
        open ? h(Details, { view }) : null,
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      ctx.slots.inject('conversation.input.dock', () =>
        ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'context-guard',
          order: 20,
          // The red popup needs the session id to call the host endpoint.
          inject: (sessionId) => ({ sessionId }),
        }, ContextGuardDock),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.ContextGuardDock = ContextGuardDock
    exports.copyText = copyText
    return module.exports
  },
})
