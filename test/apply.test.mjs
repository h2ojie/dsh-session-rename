/** Contract checks for the host half: registration shape and execute behavior. */
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'

/**
 * Build a fake context capturing the single registration.
 * @param {(session: unknown, title: string) => unknown} rename - stub rename.
 */
function harness(rename) {
  const registered = []
  const ctx = {
    tools: { register: definition => registered.push(definition) },
    sessionTitle: { rename },
  }
  apply(ctx)
  assert.equal(registered.length, 1, 'exactly one tool is registered')
  return registered[0]
}

const okRename = (_session, title) => ({ title: title.trim(), eventSeq: 7 })
const session = { id: 'session-1' }
const exec = { agent: { id: 'session-1', session } }

test('declares its loader identity and hard dependencies', () => {
  assert.equal(name, 'dsh-session-rename')
  assert.deepEqual([...inject], ['tools', 'sessionTitle'])
})

test('registers a model-visible schema with a required title', () => {
  const tool = harness(okRename)
  assert.equal(tool.name, 'rename_session')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['title'])
  assert.equal(tool.parameters.properties.title.type, 'string')
  assert.equal(typeof tool.output.render, 'function')
})

test('renames the calling agent session and returns the accepted title', async () => {
  const calls = []
  const tool = harness((target, title) => {
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
  const tool = harness(() => {
    throw new Error('session title must contain visible characters')
  })
  await assert.rejects(
    tool.execute({ title: '   ' }, exec),
    /must contain visible characters/,
  )
})

test('rejects a call with no owning agent', async () => {
  const tool = harness(okRename)
  await assert.rejects(tool.execute({ title: 'x' }, { agent: undefined }), /requires an agent Session/)
})

test('rejects malformed arguments before reaching the service', async () => {
  let called = false
  const tool = harness(() => {
    called = true
    return { title: 'x', eventSeq: 1 }
  })
  await assert.rejects(tool.execute({}, exec), /requires "title" to be a string/)
  await assert.rejects(tool.execute({ title: 42 }, exec), /requires "title" to be a string/)
  await assert.rejects(tool.execute(null, exec), /expects an object/)
  await assert.rejects(tool.execute({ title: 'x'.repeat(513) }, exec), /at most 512 characters/)
  assert.equal(called, false, 'the title service is never reached for invalid input')
})
