import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolTarget } from '../../src/agent/tools/tool-context.js'
import {
  ProgressOutputController,
  type ProgressOutputAuditEvent,
  type ProgressOutputRequest
} from '../../src/runtime/tools/progress-output.js'

const target: ToolTarget = Object.freeze({ kind: 'group', groupId: 'group-secret' })

function request (text: string, callId = 'call-secret'): ProgressOutputRequest {
  return Object.freeze({
    text,
    target,
    runId: 'run-secret',
    callId,
    snapshotId: 'snapshot-secret',
    signal: new AbortController().signal
  })
}

function deferred (): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function fixture (overrides: {
  readonly maxMessages?: number
  readonly maxCharacters?: number
  readonly send?: (text: string, target: ToolTarget, signal: AbortSignal) => Promise<void>
} = {}): {
  readonly controller: ProgressOutputController
  readonly sends: string[]
  readonly audits: ProgressOutputAuditEvent[]
} {
  const sends: string[] = []
  const audits: ProgressOutputAuditEvent[] = []
  const controller = new ProgressOutputController({
    maxMessages: overrides.maxMessages ?? 5,
    maxCharacters: overrides.maxCharacters ?? 200,
    hash: value => `hash-${value.length}`,
    send: overrides.send ?? (async text => { sends.push(text) }),
    audit: async event => { audits.push(event) }
  })
  return { controller, sends, audits }
}

test('normalizes trim and NFC before counting and sending Unicode code points', async () => {
  const { controller, sends, audits } = fixture({ maxCharacters: 2 })
  const sent = await controller.deliver(request('  e\u0301好  '))
  assert.deepEqual(sent, { kind: 'sent', sequence: 1 })
  assert.deepEqual(sends, ['é好'])
  assert.equal(audits[0]?.characters, 2)
  assert.equal(audits[0]?.bytes, Buffer.byteLength('é好'))

  const invalid = await controller.deliver(request('好好好', 'call-too-long'))
  assert.deepEqual(invalid, { kind: 'invalid' })
  assert.equal(sends.length, 1)
})

test('reserves normalized text before a concurrent send settles', async () => {
  const pending = deferred()
  const sends: string[] = []
  const audits: ProgressOutputAuditEvent[] = []
  const controller = new ProgressOutputController({
    maxMessages: 5,
    maxCharacters: 200,
    hash: value => `hash-${value.length}`,
    send: async text => { sends.push(text); await pending.promise },
    audit: async event => { audits.push(event) }
  })

  const first = controller.deliver(request('  阶段一完成  '))
  const duplicate = await controller.deliver(request('阶段一完成', 'call-duplicate'))
  assert.deepEqual(duplicate, { kind: 'duplicate' })
  assert.deepEqual(sends, ['阶段一完成'])
  pending.resolve()
  assert.deepEqual(await first, { kind: 'sent', sequence: 1 })
  assert.deepEqual(audits.map(event => event.outcome).sort(), ['duplicate', 'sent'])
})

test('allows five physical attempts and suppresses the sixth without sending', async () => {
  const { controller, sends, audits } = fixture()
  for (let sequence = 1; sequence <= 5; sequence++) {
    assert.deepEqual(
      await controller.deliver(request(`阶段${sequence}`, `call-${sequence}`)),
      { kind: 'sent', sequence }
    )
  }
  assert.deepEqual(await controller.deliver(request('阶段六', 'call-6')), { kind: 'suppressed' })
  assert.equal(sends.length, 5)
  assert.equal(audits.at(-1)?.outcome, 'suppressed')
})

test('keeps an uncertain send reserved and audits only redacted fixed metrics', async () => {
  const audits: ProgressOutputAuditEvent[] = []
  const controller = new ProgressOutputController({
    maxMessages: 5,
    maxCharacters: 200,
    hash: value => `hash-${value.length}`,
    send: async () => { throw new Error('transport-secret') },
    audit: async event => { audits.push(event) }
  })

  await assert.rejects(controller.deliver(request('敏感进度内容')))
  assert.deepEqual(await controller.deliver(request('敏感进度内容', 'call-retry')), { kind: 'duplicate' })
  assert.deepEqual(audits.map(event => event.outcome), ['indeterminate', 'duplicate'])
  const serialized = JSON.stringify(audits)
  for (const secret of ['敏感进度内容', 'group-secret', 'run-secret', 'call-secret', 'snapshot-secret', 'transport-secret']) {
    assert.equal(serialized.includes(secret), false)
  }
  assert.deepEqual(Object.keys(audits[0] ?? {}).sort(), [
    'bytes', 'callIdHash', 'characters', 'event', 'outcome',
    'runIdHash', 'sequence', 'snapshotIdHash'
  ])
})
