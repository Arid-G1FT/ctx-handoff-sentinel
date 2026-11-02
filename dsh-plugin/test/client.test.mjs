import assert from 'node:assert/strict'
import test from 'node:test'

test('client bundle loads and registers the context-guard dock', async () => {
  let loaded = null
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        loaded = definition
      },
    },
  }
  const React = {
    createElement: (...args) => ({ type: 'element', args }),
    useState: (value) => [value, () => {}],
  }
  await import('../lib/client.js')
  assert.ok(loaded !== null)
  assert.equal(loaded.id, '@local/dsh-context-guard')
  const exports = loaded.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require: ${name}`)
  })
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.ContextGuardDock, 'function')

  const registrations = []
  const injected = []
  const ctx = {
    slots: {
      inject(name, callback) {
        injected.push(name)
        callback()
      },
      register(definition, component) {
        registrations.push({ definition, component })
        return () => {}
      },
    },
  }
  exports.apply(ctx)
  assert.deepEqual(injected, ['conversation.input.dock'])
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].definition.id, 'context-guard')
  assert.equal(registrations[0].definition.order, 20)
  assert.equal(registrations[0].component, exports.ContextGuardDock)

  const view = {
    compactions: 1,
    probe: { status: 'due' },
    effective: null,
    report: null,
    files: [],
    pins: [],
    headline: '⏳ 自检待运行',
    advice: '先运行 /guard check',
    lastCompaction: { failed: false, shadowedTokens: 9000 },
    request: { model: 'deepseek-flash' },
  }
  const tree = registrations[0].component({ useProjection: () => view })
  assert.equal(tree.type, 'element')
  assert.equal(tree.args[1]['data-context-guard'], true)
})
