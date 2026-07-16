import assert from 'node:assert/strict'
import { test } from 'node:test'
// @ts-expect-error strict-object record details are not a public contract
import type { InternalStrictObject } from '../../src/agent/contracts/interaction.js'
// @ts-expect-error strict-object parsing is internal to interaction contracts
import type { parseInternalStrictObject } from '../../src/agent/contracts/interaction.js'
// @ts-expect-error exact-own-key assertion is internal to interaction contracts
import type { assertInternalExactOwnKeys } from '../../src/agent/contracts/interaction.js'
import {
  completionFromTerminalOutput,
  parseCompletionDisposition
} from '../../src/agent/contracts/completion.js'
import type { AgentMessage } from '../../src/agent/contracts/content.js'
import { AgentError } from '../../src/agent/contracts/error.js'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import {
  parsePresentationRoute,
  recoveredLegacyRoute,
  type PresentationRouteV1
} from '../../src/agent/contracts/interaction.js'
import {
  createRequestRef,
  createRunRef,
  RUN_REF_PATTERN
} from '../../src/agent/run/run-reference.js'

const timestamp = '2026-07-16T00:00:00.000Z'

function ordinaryRoute (): PresentationRouteV1 {
  return {
    schemaVersion: 1,
    requestKind: 'ordinary_chat',
    profile: 'ordinary',
    presentationIntent: {
      schemaVersion: 1,
      kind: 'ordinary',
      forcePicture: false
    },
    sessionAddress: {
      botId: '10000',
      scope: { kind: 'private', userId: '7' }
    },
    actorId: '7',
    requestMessageId: 'message-1'
  }
}

function proactiveRoute (recallAfterMs: number | null = null): PresentationRouteV1 {
  return {
    schemaVersion: 1,
    requestKind: 'proactive_chat',
    profile: 'proactive',
    presentationIntent: {
      schemaVersion: 1,
      kind: 'proactive',
      recallAfterMs
    },
    sessionAddress: {
      botId: '10000',
      scope: { kind: 'group', groupId: '8' }
    },
    actorId: '7'
  }
}

function assistantOutput (text: string): AgentMessage {
  return {
    id: 'message-2',
    role: 'assistant',
    parts: [{ type: 'text', text }],
    createdAt: timestamp,
    provenance: {
      source: 'model',
      trust: 'untrusted',
      sensitivity: 'group',
      sourceId: 'run-1',
      createdAt: timestamp
    }
  }
}

test('run and request references are exactly 32 lowercase hexadecimal characters', () => {
  const sizes: number[] = []
  const random = (size: number): Buffer => {
    sizes.push(size)
    return Buffer.from('00112233445566778899aabbccddeeff', 'hex')
  }

  assert.equal(createRunRef(random), '00112233445566778899aabbccddeeff')
  assert.equal(createRequestRef(random), '00112233445566778899aabbccddeeff')
  assert.deepEqual(sizes, [16, 16])
  assert.match(createRunRef(), RUN_REF_PATTERN)
  assert.match(createRequestRef(), RUN_REF_PATTERN)
  assert.equal(RUN_REF_PATTERN.test('A'.repeat(32)), false)
  assert.equal(RUN_REF_PATTERN.test('0'.repeat(31)), false)
  assert.throws(() => createRunRef(() => Buffer.alloc(15)), /random bytes/i)
  assert.throws(() => createRequestRef(() => Buffer.alloc(17)), /random bytes/i)
})

test('presentation route parser accepts only the locked ordinary and proactive matrices', () => {
  const ordinary = ordinaryRoute()
  const proactive = proactiveRoute(1_000)

  assert.deepEqual(parsePresentationRoute(ordinary), ordinary)
  assert.deepEqual(parsePresentationRoute(proactive), proactive)
  assert.equal(parsePresentationRoute({
    ...ordinary,
    presentationIntent: { ...ordinary.presentationIntent, forcePicture: true }
  }).presentationIntent.kind, 'ordinary')
  for (const recallAfterMs of [null, 1_000, 2_000, 3_600_000]) {
    assert.equal(
      parsePresentationRoute(proactiveRoute(recallAfterMs)).presentationIntent.kind,
      'proactive'
    )
  }

  assert.throws(() => parsePresentationRoute({
    ...ordinary,
    requestKind: 'proactive_chat'
  }), /request kind|matrix/i)
  assert.throws(() => parsePresentationRoute({
    ...ordinary,
    profile: 'proactive'
  }), /profile|matrix/i)
  assert.throws(() => parsePresentationRoute({
    ...ordinary,
    presentationIntent: proactive.presentationIntent
  }), /presentation intent|matrix/i)
  assert.throws(() => parsePresentationRoute({
    ...proactive,
    requestKind: 'ordinary_chat'
  }), /request kind|matrix/i)
  assert.throws(() => parsePresentationRoute({
    ...proactive,
    profile: 'ordinary'
  }), /profile|matrix/i)
  assert.throws(() => parsePresentationRoute({
    ...proactive,
    presentationIntent: ordinary.presentationIntent
  }), /presentation intent|matrix/i)
  assert.throws(() => parsePresentationRoute({
    ...ordinary,
    requestKind: 'legacy_unknown'
  }), /request kind|matrix/i)
})

test('presentation route parser enforces literal intent values and recall bounds', () => {
  const ordinary = ordinaryRoute()
  for (const forcePicture of [0, 1, 'false', null, undefined]) {
    assert.throws(() => parsePresentationRoute({
      ...ordinary,
      presentationIntent: { ...ordinary.presentationIntent, forcePicture }
    }), /force picture/i)
  }

  for (const recallAfterMs of [undefined, 0, 999, 1_500, 3_600_001, '1000', NaN]) {
    assert.throws(() => parsePresentationRoute({
      ...proactiveRoute(),
      presentationIntent: { schemaVersion: 1, kind: 'proactive', recallAfterMs }
    }), /recall/i)
  }
})

test('presentation route parser bounds request message IDs by UTF-8 bytes', () => {
  const route = ordinaryRoute()
  assert.equal(parsePresentationRoute({
    ...route,
    requestMessageId: 'a'.repeat(128)
  }).requestMessageId, 'a'.repeat(128))
  assert.equal(parsePresentationRoute({
    ...route,
    requestMessageId: '你'.repeat(42)
  }).requestMessageId, '你'.repeat(42))

  for (const requestMessageId of ['', 'a'.repeat(129), '你'.repeat(43), undefined]) {
    assert.throws(() => parsePresentationRoute({
      ...route,
      requestMessageId
    }), /request message ID/i)
  }
})

test('presentation route parser validates canonical session identifiers and exact own keys', () => {
  const route = ordinaryRoute()
  const groupUserRoute = {
    ...route,
    sessionAddress: {
      botId: 'b'.repeat(128),
      scope: {
        kind: 'group_user',
        groupId: 'g'.repeat(128),
        userId: 'u'.repeat(128)
      }
    },
    actorId: 'a'.repeat(128)
  }
  assert.equal(parsePresentationRoute(groupUserRoute).sessionAddress.scope.kind, 'group_user')

  for (const invalid of [
    { ...route, actorId: '' },
    { ...route, actorId: 'a'.repeat(129) },
    { ...route, sessionAddress: { ...route.sessionAddress, botId: 10000 } },
    {
      ...route,
      sessionAddress: { ...route.sessionAddress, botId: new String('10000') }
    },
    {
      ...route,
      sessionAddress: { botId: '10000', scope: { kind: 'private', userId: 7 } }
    },
    {
      ...route,
      sessionAddress: { botId: '10000', scope: { kind: 'group', groupId: 8 } }
    },
    {
      ...route,
      sessionAddress: {
        botId: '10000',
        scope: { kind: 'group_user', groupId: '8', userId: 7 }
      }
    },
    { ...route, sessionAddress: { ...route.sessionAddress, botId: '' } },
    { ...route, sessionAddress: { ...route.sessionAddress, botId: 'b'.repeat(129) } },
    {
      ...route,
      sessionAddress: { botId: '10000', scope: { kind: 'private', userId: '' } }
    },
    {
      ...route,
      sessionAddress: {
        botId: '10000',
        scope: { kind: 'group_user', groupId: '8', userId: 'u'.repeat(129) }
      }
    }
  ]) {
    assert.throws(() => parsePresentationRoute(invalid), /actor|session|identifier|user ID|bot ID/i)
  }

  assert.throws(() => parsePresentationRoute({ ...route, apiKey: 'secret' }), /unknown.*apiKey/i)
  assert.throws(() => parsePresentationRoute({
    ...route,
    presentationIntent: { ...route.presentationIntent, mode: 'unsafe' }
  }), /unknown.*mode/i)
  assert.throws(() => parsePresentationRoute({
    ...route,
    sessionAddress: { ...route.sessionAddress, transport: 'unsafe' }
  }), /unknown.*transport/i)
  assert.throws(() => parsePresentationRoute({
    ...route,
    sessionAddress: {
      ...route.sessionAddress,
      scope: { ...route.sessionAddress.scope, userId: '7', secret: true }
    }
  }), /unknown.*secret/i)
  assert.throws(() => parsePresentationRoute({
    requestKind: route.requestKind,
    profile: route.profile,
    presentationIntent: route.presentationIntent,
    sessionAddress: route.sessionAddress,
    actorId: route.actorId
  }), /schema version|missing/i)

  let hostileGetterRead = false
  const hostile = { ...route }
  Object.defineProperty(hostile, 'providerCredential', {
    enumerable: true,
    get () {
      hostileGetterRead = true
      throw new Error('hostile getter was evaluated')
    }
  })
  assert.throws(() => parsePresentationRoute(hostile), /unknown.*providerCredential/i)
  assert.equal(hostileGetterRead, false)

  let nestedHostileGetterRead = false
  const hostileIntent = { ...route.presentationIntent }
  Object.defineProperty(hostileIntent, 'providerCredential', {
    enumerable: true,
    get () {
      nestedHostileGetterRead = true
      throw new Error('nested hostile getter was evaluated')
    }
  })
  assert.throws(() => parsePresentationRoute({
    ...route,
    presentationIntent: hostileIntent
  }), /unknown.*providerCredential/i)
  assert.equal(nestedHostileGetterRead, false)
})

test('legacy recovery builds only an untrusted plain-text presentation route', () => {
  const sessionAddress: SessionAddress = {
    botId: '10000',
    scope: { kind: 'group_user', groupId: '8', userId: '7' }
  }
  const route = recoveredLegacyRoute(sessionAddress)

  assert.deepEqual(route, {
    schemaVersion: 1,
    requestKind: 'legacy_unknown',
    profile: 'recovered_legacy_plain_text',
    sessionAddress
  })
  assert.deepEqual(Object.keys(route), [
    'schemaVersion',
    'requestKind',
    'profile',
    'sessionAddress'
  ])
  assert.equal('actorId' in route, false)
  assert.equal('requestMessageId' in route, false)
  assert.equal('presentationIntent' in route, false)
  assert.throws(() => recoveredLegacyRoute({
    ...sessionAddress,
    scope: { ...sessionAddress.scope, unsafe: true }
  } as unknown as SessionAddress), /unknown.*unsafe|session/i)
})

test('completion parser returns frozen canonical dispositions with exact keys', () => {
  const callerOwned = { kind: 'reply_text', text: '  e\u0301  ' }
  const reply = parseCompletionDisposition(callerOwned)
  assert.deepEqual(reply, { kind: 'reply_text', text: 'é' })
  assert.notEqual(reply, callerOwned)
  assert.equal(Object.isFrozen(reply), true)

  const visible = parseCompletionDisposition({
    kind: 'already_visible',
    source: 'tool_output'
  })
  assert.deepEqual(visible, { kind: 'already_visible', source: 'tool_output' })
  assert.equal(Object.isFrozen(visible), true)

  const silent = parseCompletionDisposition({
    kind: 'allowed_silence',
    reason: 'proactive_empty_directive'
  })
  assert.deepEqual(silent, {
    kind: 'allowed_silence',
    reason: 'proactive_empty_directive'
  })
  assert.equal(Object.isFrozen(silent), true)

  for (const invalid of [
    { kind: 'reply_text', text: '   ' },
    { kind: 'reply_text' },
    { kind: 'reply_text', text: 'ok', source: 'tool_output' },
    { kind: 'already_visible', source: 'visible_output' },
    { kind: 'already_visible' },
    { kind: 'already_visible', source: 'tool_output', text: 'unsafe' },
    { kind: 'allowed_silence', reason: 'empty' },
    { kind: 'allowed_silence' },
    { kind: 'allowed_silence', reason: 'proactive_empty_directive', text: 'unsafe' },
    { kind: 'other', text: 'unsafe' },
    null,
    []
  ]) {
    assert.throws(() => parseCompletionDisposition(invalid), TypeError)
  }
})

test('completion parser rejects hostile extra keys before reading them', () => {
  let hostileGetterRead = false
  const hostile = { kind: 'reply_text', text: 'safe' }
  Object.defineProperty(hostile, 'legacyBody', {
    enumerable: true,
    get () {
      hostileGetterRead = true
      throw new Error('hostile getter was evaluated')
    }
  })

  assert.throws(() => parseCompletionDisposition(hostile), /unknown.*legacyBody/i)
  assert.equal(hostileGetterRead, false)

  let hiddenGetterRead = false
  const hidden = { kind: 'reply_text', text: 'safe' }
  Object.defineProperty(hidden, 'hiddenBody', {
    enumerable: false,
    get () {
      hiddenGetterRead = true
      throw new Error('hidden getter was evaluated')
    }
  })
  assert.throws(() => parseCompletionDisposition(hidden), /unknown.*hiddenBody/i)
  assert.equal(hiddenGetterRead, false)

  const symbolExtra = { kind: 'reply_text', text: 'safe' }
  Object.defineProperty(symbolExtra, Symbol('legacyBody'), { value: 'unsafe' })
  assert.throws(() => parseCompletionDisposition(symbolExtra), /unknown.*Symbol\(legacyBody\)/i)

  const inheritedKind = Object.assign(Object.create({ kind: 'reply_text' }), {
    text: 'safe'
  })
  assert.throws(() => parseCompletionDisposition(inheritedKind), /missing.*kind/i)
  const inheritedExtra = Object.assign(Object.create({ legacyBody: 'ignored' }), {
    kind: 'reply_text',
    text: 'safe'
  })
  assert.deepEqual(parseCompletionDisposition(inheritedExtra), {
    kind: 'reply_text',
    text: 'safe'
  })
})

test('terminal completion requires confirmed tool visibility to be text-free', () => {
  for (const requestKind of ['ordinary_chat', 'proactive_chat', 'legacy_unknown'] as const) {
    assert.deepEqual(completionFromTerminalOutput({
      requestKind,
      output: null,
      visibleToolOutput: 'confirmed'
    }), { kind: 'already_visible', source: 'tool_output' })
  }

  assert.throws(() => completionFromTerminalOutput({
    requestKind: 'ordinary_chat',
    output: assistantOutput('already sent'),
    visibleToolOutput: 'confirmed'
  }), /visible|output/i)
  assert.throws(() => completionFromTerminalOutput({
    requestKind: 'ordinary_chat',
    output: null,
    visibleToolOutput: 'none'
  }), /output/i)
  assert.throws(() => completionFromTerminalOutput({
    requestKind: new String('ordinary_chat'),
    output: assistantOutput('unsafe alias'),
    visibleToolOutput: 'none'
  } as unknown as Parameters<typeof completionFromTerminalOutput>[0]), /request kind/i)
})

test('terminal completion normalizes canonical assistant text and preserves ordinary EMPTY', () => {
  assert.deepEqual(completionFromTerminalOutput({
    requestKind: 'ordinary_chat',
    output: assistantOutput('  e\u0301  '),
    visibleToolOutput: 'none'
  }), { kind: 'reply_text', text: 'é' })
  assert.deepEqual(completionFromTerminalOutput({
    requestKind: 'ordinary_chat',
    output: assistantOutput(' \n<EMPTY>\t '),
    visibleToolOutput: 'none'
  }), { kind: 'reply_text', text: '<EMPTY>' })
  assert.deepEqual(completionFromTerminalOutput({
    requestKind: 'proactive_chat',
    output: assistantOutput('<EMPTY> plus text'),
    visibleToolOutput: 'none'
  }), { kind: 'reply_text', text: '<EMPTY> plus text' })
  assert.deepEqual(completionFromTerminalOutput({
    requestKind: 'legacy_unknown',
    output: assistantOutput('legacy text remains visible'),
    visibleToolOutput: 'none'
  }), { kind: 'reply_text', text: 'legacy text remains visible' })
})

test('terminal completion allows only proactive exact EMPTY silence', () => {
  assert.deepEqual(completionFromTerminalOutput({
    requestKind: 'proactive_chat',
    output: assistantOutput(' \n<EMPTY>\t '),
    visibleToolOutput: 'none'
  }), {
    kind: 'allowed_silence',
    reason: 'proactive_empty_directive'
  })
})

test('legacy exact EMPTY fails with the dedicated safe AgentError', () => {
  const legacyOutput = {
    ...assistantOutput(' \n<EMPTY>\t '),
    id: 'old private body must not leak'
  }
  let thrown: unknown
  try {
    completionFromTerminalOutput({
      requestKind: 'legacy_unknown',
      output: legacyOutput,
      visibleToolOutput: 'none'
    })
  } catch (error) {
    thrown = error
  }

  assert.ok(thrown instanceof AgentError)
  assert.equal(thrown.code, 'legacy_entry_kind_unavailable')
  assert.equal(thrown.stage, 'run.completion')
  assert.equal(thrown.retryable, false)
  assert.equal(thrown.userMessage, '旧任务缺少可信入口信息，无法安全恢复回复。')
  assert.deepEqual(thrown.details, {})
  assert.doesNotMatch(JSON.stringify(thrown), /old private body/i)
})

test('terminal completion rejects non-canonical assistant outputs', () => {
  const canonical = assistantOutput('safe')
  const inheritedReplyTo = Object.assign(Object.create({
    replyTo: {
      messageId: 'quoted-inherited',
      sender: { userId: '7' },
      parts: [{ type: 'text', text: 'quoted' }]
    }
  }), canonical)
  const invalidOutputs: unknown[] = [
    { ...canonical, role: 'user' },
    { ...canonical, parts: [] },
    { ...canonical, parts: [...canonical.parts, { type: 'text', text: 'extra' }] },
    { ...canonical, parts: [{ type: 'mention', userId: '7' }] },
    {
      ...canonical,
      replyTo: {
        messageId: 'quoted-1',
        sender: { userId: '7' },
        parts: [{ type: 'text', text: 'quoted' }]
      }
    },
    inheritedReplyTo,
    assistantOutput(' \n\t ')
  ]

  for (const output of invalidOutputs) {
    assert.throws(() => completionFromTerminalOutput({
      requestKind: 'ordinary_chat',
      output: output as AgentMessage,
      visibleToolOutput: 'none'
    }), TypeError)
  }
})
