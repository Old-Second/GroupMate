import assert from 'node:assert/strict'
import { test } from 'node:test'
import { prepareYunzaiMessageEvidence } from '../../dist/runtime/message-input.js'
import {
  adaptYunzaiRequest,
  prepareYunzaiPresentationRequest
} from '../../dist/runtime/yunzai-request-adapter.js'

const requestRuntime = Object.freeze({
  requestId: 'request-characterization',
  requestRef: '66666666666666666666666666666666',
  createdAt: '2026-07-16T01:00:00.000Z',
  deadlineAt: '2026-07-16T01:04:00.000Z',
  systemInstructions: Object.freeze(['system fixture']),
  model: Object.freeze({
    model: 'fixture-model', streaming: false, maxOutputTokens: 256,
    reasoning: Object.freeze({ enabled: false })
  }),
  contextBudget: Object.freeze({
    modelContextTokens: 4_096, reservedOutputTokens: 256,
    reservedToolTokens: 512, safetyMarginTokens: 128,
    maxItems: 32, maxBytes: 128 * 1_024
  })
})

test('typed request evidence resolves quoted images once and is reused by the route and adapter', async () => {
  let historyCalls = 0
  const event = {
    isGroup: true,
    group_id: 'group-1',
    self_id: 'bot-1',
    user_id: 'actor-1',
    message_id: 'current-message',
    sender: { user_id: 'actor-1', nickname: 'member', role: 'member' },
    message: [
      { type: 'text', text: 'current raw value' },
      { type: 'image', url: 'https://fixture.invalid/current.png' }
    ],
    source: { seq: 42 },
    group: {
      async getChatHistory () {
        historyCalls++
        return [{
          message_id: 'quoted-message',
          sender: { user_id: 'actor-2', nickname: 'quoted member' },
          message: [
            { type: 'text', text: 'quoted content' },
            { type: 'image', url: 'https://fixture.invalid/quoted.png' }
          ]
        }]
      }
    }
  }
  const evidence = await prepareYunzaiMessageEvidence({
    event,
    currentPrompt: 'authorized current request',
    ocrTexts: ['  O\u0308CR  ']
  })
  const prepared = prepareYunzaiPresentationRequest({
    event,
    evidence,
    requestKind: 'ordinary_chat',
    presentationIntent: {
      schemaVersion: 1,
      kind: 'ordinary',
      forcePicture: false
    },
    getBotId: value => String(value.self_id)
  })
  const request = await adaptYunzaiRequest({
    event,
    messageEvidence: evidence,
    presentationRoute: prepared.route,
    ...requestRuntime
  })

  assert.equal(historyCalls, 1)
  assert.strictEqual(prepared.evidence, evidence)
  assert.strictEqual(request.presentationRoute, prepared.route)
  assert.strictEqual(request.sessionAddress, prepared.route.sessionAddress)
  assert.deepEqual(evidence.ocrTexts, ['ÖCR'])
  assert.deepEqual(evidence.imageUrls, [
    'https://fixture.invalid/current.png',
    'https://fixture.invalid/quoted.png'
  ])
  assert.equal(request.message.parts.filter(part => part.type === 'resource_ref').length, 2)
  assert.equal(Object.isFrozen(evidence), true)
  assert.equal(Object.isFrozen(evidence.quotedMessage?.parts), true)
})

test('typed request adapter fails closed when a prepared route crosses event identity', async () => {
  const event = {
    isGroup: false,
    self_id: 'bot-1',
    user_id: 'actor-1',
    sender: { user_id: 'actor-1', role: 'member' },
    message: [{ type: 'text', text: 'request' }]
  }
  const evidence = await prepareYunzaiMessageEvidence({
    event,
    currentPrompt: 'request',
    ocrTexts: []
  })
  const prepared = prepareYunzaiPresentationRequest({
    event,
    evidence,
    requestKind: 'ordinary_chat',
    presentationIntent: {
      schemaVersion: 1,
      kind: 'ordinary',
      forcePicture: false
    },
    getBotId: value => String(value.self_id)
  })

  await assert.rejects(adaptYunzaiRequest({
    event,
    messageEvidence: evidence,
    presentationRoute: Object.freeze({
      ...prepared.route,
      sessionAddress: Object.freeze({
        botId: 'bot-1',
        scope: Object.freeze({ kind: 'private', userId: 'different-actor' })
      })
    }),
    ...requestRuntime,
    requestId: 'request-crossed-route'
  }), /route session|route identity/i)
})
