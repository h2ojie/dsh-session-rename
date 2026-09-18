/** Contract checks for the host half: registration shape and execute behavior. */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'

/**
 * Build a fake context capturing the registration and any listener.
 *
 * `apply` now registers an `agent/pre-step` listener, so the context must offer
 * `on`; the pre-existing tool contract tests below are untouched by it.
 *
 * @param {(session: unknown, title: string) => unknown} rename - stub rename.
 * @param {(session: unknown) => unknown} [current] - stub `sessionTitle.get`.
 * @param {unknown} [config] - loader config forwarded to `apply`.
 */
function harness(rename, current = () => undefined, config) {
  const registered = []
  const listeners = []
  const ctx = {
    tools: { register: definition => registered.push(definition) },
    sessionTitle: { rename, get: current },
    on: (event, listener) => { listeners.push({ event, listener }) },
  }
  apply(ctx, config)
  assert.equal(registered.length, 1, 'exactly one tool is registered')
  return { tool: registered[0], ctx, listeners }
}

/** Run the `agent/pre-step` listener with one batch of claimed messages. */
async function step(h, { agent = { session }, messages = [] } = {}) {
  const entry = h.listeners.find(item => item.event === 'agent/pre-step')
  assert.ok(entry, 'the plugin listens on agent/pre-step')
  return entry.listener({ agent, messages }, async () => ({ kind: 'enter', messages }))
}

const okRename = (_session, title) => ({ title: title.trim(), eventSeq: 7 })
const session = { id: 'session-1' }
const exec = { agent: { id: 'session-1', session } }

test('declares its loader identity and hard dependencies', () => {
  assert.equal(name, 'dsh-session-rename')
  assert.deepEqual([...inject], ['tools', 'sessionTitle'])
})

test('registers a model-visible schema with a required title', () => {
  const { tool } = harness(okRename)
  assert.equal(tool.name, 'rename_session')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['title'])
  assert.equal(tool.parameters.properties.title.type, 'string')
  assert.equal(typeof tool.output.render, 'function')
})

test('renames the calling agent session and returns the accepted title', async () => {
  const calls = []
  const { tool } = harness((target, title) => {
    calls.push({ target, title })
    return { title: title.trim(), eventSeq: 12 }
  })
  const value = await tool.execute({ title: '  Fixed the login bug  ' }, exec)
  assert.deepEqual(calls, [{ target: session, title: '  Fixed the login bug  ' }])
  assert.deepEqual(value, { title: 'Fixed the login bug', seq: 12 })
  assert.deepEqual(tool.output.render({}, value), [
    { type: 'text', text: 'Session renamed to: Fixed the login bug' },
  ])
})

test('propagates a title-service rejection unchanged', async () => {
  const { tool } = harness(() => {
    throw new Error('session title must contain visible characters')
  })
  await assert.rejects(
    tool.execute({ title: '   ' }, exec),
    /must contain visible characters/,
  )
})

test('rejects a call with no owning agent', async () => {
  const { tool } = harness(okRename)
  await assert.rejects(tool.execute({ title: 'x' }, { agent: undefined }), /requires an agent Session/)
})

test('rejects malformed arguments before reaching the service', async () => {
  let called = false
  const { tool } = harness(() => {
    called = true
    return { title: 'x', eventSeq: 1 }
  })
  await assert.rejects(tool.execute({}, exec), /requires "title" to be a string/)
  await assert.rejects(tool.execute({ title: 42 }, exec), /requires "title" to be a string/)
  await assert.rejects(tool.execute(null, exec), /expects an object/)
  await assert.rejects(tool.execute({ title: 'x'.repeat(513) }, exec), /at most 512 characters/)
  assert.equal(called, false, 'the title service is never reached for invalid input')
})

// --- Automatic renaming -----------------------------------------------------
// Paths are verbatim from real sessions, so the regex is checked against the
// exact shapes it must survive: UNC roots, CJK subjects, spaces, and a subject
// whose original `/` was replaced by a space to stay a legal filename.

const TICKET_59758 = '\\\\10.40.73.81\\data2\\学习机BUG'
  + '\\202609181431-59758-【T90 Lite】【自动关机 重启】门店来电表示顾客的机器会出现自动'
  + '\\system-exceptions-DP022012260906583-20260918'

const TICKET_59474 = 'Y:\\学习机BUG'
  + '\\202609171111-59474-【T20Pro】【自动关机】网点表示不固定关机 多次 最近一次是13号'
  + '\\CT012011232309302-20260916-16-28-21\\tombstones'

/** One claimed human message carrying `text`. */
function userMessage(text) {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

test('renames from a ticket path in the first human message', async () => {
  const calls = []
  const h = harness((target, title) => {
    calls.push({ target, title })
    return { title, eventSeq: 3 }
  })
  await step(h, { messages: [userMessage(`/focus-analyze ${TICKET_59758}`)] })
  assert.deepEqual(calls, [{ target: session, title: '59758-【T90 Lite】【自动关机 重启】门' }])
})

test('renames a second ticket path and keeps the first-match ticket', async () => {
  const calls = []
  const h = harness((target, title) => {
    calls.push(title)
    return { title, eventSeq: 3 }
  })
  await step(h, { messages: [userMessage(`/focus-analyze ${TICKET_59474}`)] })
  // Two path segments carry the stamp pattern here; the FIRST wins. The subject
  // is cut at 20 code points, which is why it ends mid-word — that is the
  // literal-20 rule the user chose, documented as a known rough edge.
  assert.deepEqual(calls, ['59474-【T20Pro】【自动关机】网点表示不固'])
})

test('ignores injected context: only a human message can name the ticket', async () => {
  let called = false
  const h = harness(() => {
    called = true
    return { title: 'x', eventSeq: 1 }
  })
  // Workspace rules, skill bodies, and plugin notices are all non-`user`.
  await step(h, { messages: [
    { role: 'user', source: { kind: 'agent-instructions' }, content: [{ type: 'text', text: TICKET_59758 }] },
    { role: 'user', source: { kind: 'skill-invocation', name: 'focus-analyze' }, content: [{ type: 'text', text: TICKET_59758 }] },
    { role: 'user', source: { kind: 'plugin', plugin: 'other' }, content: [{ type: 'text', text: TICKET_59758 }] },
  ] })
  assert.equal(called, false)
})

test('ignores a bare number sequence written in prose', async () => {
  let called = false
  const h = harness(() => {
    called = true
    return { title: 'x', eventSeq: 1 }
  })
  await step(h, { messages: [userMessage('202609181431-59758-this is not a path')] })
  // No path separator precedes the digits, so it is not a ticket directory.
  assert.equal(called, false)
})

test('takes over an automatic fallback or provider title', async () => {
  const calls = []
  for (const current of [
    { title: '/focus-analyze \\\\10.40.73.81\\data2\\学', source: { kind: 'fallback' } },
    { title: '分析学习机异常掉电日志', source: { kind: 'provider', provider: 'x' } },
  ]) {
    const h = harness((_target, title) => {
      calls.push(title)
      return { title, eventSeq: 3 }
    }, () => current)
    await step(h, { messages: [userMessage(TICKET_59758)] })
  }
  assert.deepEqual(calls, ['59758-【T90 Lite】【自动关机 重启】门', '59758-【T90 Lite】【自动关机 重启】门'])
})

test('renames once: a later ticket never moves the title', async () => {
  const calls = []
  // Stand-in for "this session was already named from an earlier ticket".
  const h = harness((_target, title) => {
    calls.push(title)
    return { title, eventSeq: 3 }
  }, () => ({ title: '59474-【T20Pro】【自动关机】网点表示不固', source: { kind: 'user' } }))

  await step(h, { messages: [userMessage(TICKET_59758)] })
  assert.deepEqual(calls, [], 'a later ticket must not rewrite the first')
})

test('renames once: a human title is terminal', async () => {
  let called = false
  const h = harness(() => {
    called = true
    return { title: 'x', eventSeq: 1 }
  }, () => ({ title: '分析学习机异常掉电日志', source: { kind: 'user' } }))
  await step(h, { messages: [userMessage(TICKET_59758)] })
  assert.equal(called, false)
})

test('once: false follows the ticket when it changes', async () => {
  const calls = []
  const h = harness((_target, title) => {
    calls.push(title)
    return { title, eventSeq: 3 }
  }, () => ({ title: '59474-【T20Pro】【自动关机】网点表示不固', source: { kind: 'user' } }), { once: false })

  // Same ticket, a differently cut title → no rewrite.
  await step(h, { messages: [userMessage(TICKET_59474)] })
  assert.deepEqual(calls, [])

  // A new ticket → renamed, per the AGENTS.md "current ticket wins" rule.
  await step(h, { messages: [userMessage(TICKET_59758)] })
  assert.deepEqual(calls, ['59758-【T90 Lite】【自动关机 重启】门'])
})

test('once: false still leaves a non-ticket human title alone', async () => {
  let called = false
  const h = harness(() => {
    called = true
    return { title: 'x', eventSeq: 1 }
  }, () => ({ title: '分析学习机异常掉电日志', source: { kind: 'user' } }), { once: false })
  await step(h, { messages: [userMessage(TICKET_59758)] })
  assert.equal(called, false)
})

test('autoRename: false registers the tool and no listener', () => {
  const registered = []
  const listeners = []
  apply({
    tools: { register: definition => registered.push(definition) },
    sessionTitle: { rename: okRename, get: () => undefined },
    on: (event, listener) => listeners.push({ event, listener }),
  }, { autoRename: false })
  assert.equal(registered.length, 1)
  assert.deepEqual(listeners, [])
})

test('honors a configured titleChars and falls back for junk values', async () => {
  const full = '59758-【T90 Lite】【自动关机 重启】门'
  for (const [config, expected] of [
    [{ titleChars: 6 }, '59758-【T90 L'],
    [{ titleChars: 0 }, full],
    [{ titleChars: 'lots' }, full],
  ]) {
    const calls = []
    const h = harness((_target, title) => {
      calls.push(title)
      return { title, eventSeq: 3 }
    }, () => undefined, config)
    await step(h, { messages: [userMessage(TICKET_59758)] })
    assert.deepEqual(calls, [expected], JSON.stringify(config))
  }
})

test('a failing rename never breaks the step', async () => {
  const h = harness(() => {
    throw new Error('session title must contain visible characters')
  })
  const decision = await step(h, { messages: [userMessage(TICKET_59758)] })
  assert.deepEqual(decision, { kind: 'enter', messages: [userMessage(TICKET_59758)] })
})
