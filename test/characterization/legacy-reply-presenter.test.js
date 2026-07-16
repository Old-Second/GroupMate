import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildLegacyQuoteForwardMessages,
  buildLegacyThinkingForwardMessages,
  presentLegacyReply,
  selectLegacyPresentationMode
} from '../../model/legacy/reply-presenter.js'
import { createLegacyYunzaiFake } from '../helpers/legacy-yunzai-fake.js'
import { ReplyPresenter } from '../../dist/runtime/presentation/reply-presenter.js'
import { ordinaryProfile } from '../../dist/runtime/presentation/presentation-profile.js'
import {
  createInitialRunObservationCounters,
  terminalObservationId
} from '../../dist/agent/run/run-observation.js'

test('legacy reasoning forwards explicit segments before parsed thinking blocks', () => {
  assert.deepEqual(buildLegacyThinkingForwardMessages('', []), [])
  assert.deepEqual(
    buildLegacyThinkingForwardMessages('ignored', [' first ', '', 'second']),
    ['first', 'second']
  )
  assert.deepEqual(
    buildLegacyThinkingForwardMessages('【模型思考】\nfixture one\n\n【工具调用：weather】\nfixture two'),
    ['【模型思考】\nfixture one', '【工具调用：weather】\nfixture two']
  )
})

test('legacy quote forwards omit blank text and retain text-url formatting', () => {
  assert.deepEqual(buildLegacyQuoteForwardMessages([
    { text: 'fixture source', url: 'https://fixture.invalid/source' },
    { text: '   ', url: 'https://fixture.invalid/ignored' }
  ]), ['fixture source - https://fixture.invalid/source'])
})

test('legacy presentation mode keeps TTS then picture then text priority', () => {
  assert.equal(selectLegacyPresentationMode({ useTTS: true, forcePictureMode: true }), 'tts')
  assert.equal(selectLegacyPresentationMode({ forcePictureMode: true }), 'picture')
  assert.equal(selectLegacyPresentationMode({ userPictureMode: true }), 'picture')
  assert.equal(selectLegacyPresentationMode({
    autoPicture: true,
    responseLength: 1201,
    autoPictureThreshold: 1200
  }), 'picture')
  assert.equal(selectLegacyPresentationMode({
    autoPicture: true,
    responseLength: 1200,
    autoPictureThreshold: 1200
  }), 'text')
})

test('legacy group reply mutates array payload with markdown buttons and recalls bot message first', async () => {
  const { calls, event, handler, logger, plugin } = createLegacyYunzaiFake()
  const message = ['fixture response']
  const data = { recallMsg: 3, marker: 'fixture' }

  const result = await presentLegacyReply({
    event,
    message,
    quote: true,
    data,
    markdownEnabled: true,
    handler,
    logger,
    schedule: plugin.schedule
  })

  assert.deepEqual(result, { message_id: 'fixture-bot-message' })
  assert.strictEqual(calls.replies[0].message, message)
  assert.deepEqual(calls.replies[0], {
    message: ['fixture response', { type: 'button', content: [{ text: 'fixture button' }] }],
    quote: true,
    data: { recallMsg: 0, marker: 'fixture' }
  })
  assert.deepEqual(calls.handler, [{
    name: 'chatgpt.button.post',
    eventId: 'fixture-event',
    data
  }])
  assert.deepEqual(data, { recallMsg: 3, marker: 'fixture' })
  assert.equal(calls.schedules[0].delay, 3000)
  calls.schedules[0].callback()
  assert.deepEqual(calls.groupRecalls, ['fixture-bot-message'])
  assert.deepEqual(calls.friendRecalls, [])
})

test('legacy markdown-disabled reply bypasses the button handler', async () => {
  const { calls, event, handler, logger, plugin } = createLegacyYunzaiFake()

  await presentLegacyReply({
    event,
    message: 'fixture response',
    quote: false,
    data: { marker: 'fixture' },
    markdownEnabled: false,
    handler,
    logger,
    schedule: plugin.schedule
  })

  assert.deepEqual(calls.handler, [])
  assert.deepEqual(calls.replies, [{
    message: 'fixture response',
    quote: false,
    data: { marker: 'fixture', recallMsg: 0 }
  }])
  assert.deepEqual(calls.schedules, [])
})

test('legacy private reply schedules friend recall when no group exists', async () => {
  const { calls, event, handler, logger, plugin } = createLegacyYunzaiFake({ isGroup: false })

  await presentLegacyReply({
    event,
    message: 'fixture private response',
    quote: true,
    data: { recallMsg: 2 },
    markdownEnabled: false,
    handler,
    logger,
    schedule: plugin.schedule
  })

  assert.equal(calls.schedules[0].delay, 2000)
  calls.schedules[0].callback()
  assert.deepEqual(calls.groupRecalls, [])
  assert.deepEqual(calls.friendRecalls, ['fixture-bot-message'])
})

test('legacy markdown handler uses the dynamic event while reply and recall stay on the reply event', async () => {
  for (const isGroup of [true, false]) {
    const { calls, event, logger, plugin } = createLegacyYunzaiFake({ isGroup })
    const handlerCalls = []
    const handlerTransportCalls = []
    const handlerEvent = {
      event_id: `fixture-handler-${isGroup ? 'group' : 'friend'}-event`,
      async reply () {
        handlerTransportCalls.push('reply')
        return { message_id: 'fixture-handler-message' }
      },
      group: {
        recallMsg (messageId) {
          handlerTransportCalls.push(`group:${messageId}`)
          return Promise.resolve()
        }
      },
      friend: {
        recallMsg (messageId) {
          handlerTransportCalls.push(`friend:${messageId}`)
          return Promise.resolve()
        }
      }
    }
    const handler = {
      async call (name, receivedEvent, data) {
        handlerCalls.push({ name, receivedEvent, data })
        return [{ text: 'fixture dynamic button' }]
      }
    }
    const data = { recallMsg: 1, marker: 'fixture-dynamic-event' }

    await presentLegacyReply({
      event,
      handlerEvent,
      message: 'fixture response',
      quote: true,
      data,
      markdownEnabled: true,
      handler,
      logger,
      schedule: plugin.schedule
    })

    assert.equal(handlerCalls.length, 1)
    assert.equal(handlerCalls[0].name, 'chatgpt.button.post')
    assert.strictEqual(handlerCalls[0].receivedEvent, handlerEvent)
    assert.strictEqual(handlerCalls[0].data, data)
    assert.deepEqual(calls.replies, [{
      message: [
        'fixture response',
        { type: 'button', content: [{ text: 'fixture dynamic button' }] }
      ],
      quote: true,
      data: { recallMsg: 0, marker: 'fixture-dynamic-event' }
    }])

    assert.equal(calls.schedules[0].delay, 1000)
    calls.schedules[0].callback()
    assert.deepEqual(
      calls.groupRecalls,
      isGroup ? ['fixture-bot-message'] : []
    )
    assert.deepEqual(
      calls.friendRecalls,
      isGroup ? [] : ['fixture-bot-message']
    )
    assert.deepEqual(handlerTransportCalls, [])
  }
})

test('typed presenter preserves quote forward trusted button and response-post behavior', async () => {
  const calls = []
  const notifications = []
  const port = {
    target: { botId: 'bot-1', scope: { kind: 'group', groupId: 'group-1' } },
    async deliver (part, attempt, options) {
      calls.push({ part, attempt, options })
      return {
        kind: 'sent',
        media: part.media,
        attempt,
        receipt: { schemaVersion: 1, media: part.media, messageId: `bot-${calls.length}` }
      }
    },
    async recall () {
      return { kind: 'recalled' }
    }
  }
  const presenter = new ReplyPresenter({
    outboundFactory: { forTarget: async () => port },
    tts: {
      async synthesize () {
        return { kind: 'failed_definite', code: 'synthesis_rejected' }
      }
    },
    ttsDiagnostics: {
      reportSynthesisFailure () {}
    },
    random: () => 0.5,
    sleep: async () => undefined,
    schedule: () => undefined
  })
  const route = {
    schemaVersion: 1,
    requestKind: 'ordinary_chat',
    profile: 'ordinary',
    presentationIntent: { schemaVersion: 1, kind: 'ordinary', forcePicture: false },
    sessionAddress: port.target,
    actorId: 'actor-1',
    requestMessageId: 'request-1'
  }
  const runRef = '3'.repeat(32)
  const revision = 2
  const observationId = terminalObservationId(runRef, revision)
  const counters = createInitialRunObservationCounters()
  const result = await presenter.present({
    result: {
      kind: 'completed',
      runId: 'run-1',
      runRef,
      completion: { kind: 'reply_text', text: 'fixture response' },
      output: {
        id: 'message-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'fixture response' }],
        createdAt: '2026-07-16T00:00:00.000Z',
        provenance: {
          source: 'agent_output',
          trust: 'trusted',
          sensitivity: 'group',
          sourceId: runRef,
          createdAt: '2026-07-16T00:00:00.000Z'
        }
      },
      terminal: {
        snapshot: {
          schemaVersion: 2,
          observationId,
          runRef,
          revision,
          status: 'completed',
          finishedAt: '2026-07-16T00:00:00.000Z',
          completion: { kind: 'reply_text', lengthBucket: '1_40' },
          errorCode: null,
          cancellationReason: null,
          counters,
          engineDurationMs: counters.engineActiveDurationMs
        },
        receipt: {
          schemaVersion: 1,
          observationId,
          runRef,
          revision,
          deletedKeyCount: 2,
          createdKeyCount: 1,
          checkpointBytesDeleted: 10,
          eventBytesDeleted: 10,
          tombstoneBytes: 100
        }
      }
    },
    sessionPersistence: 'saved',
    route,
    profile: ordinaryProfile({ forcePicture: false, quoteCurrentRequest: true }),
    settings: {
      schemaVersion: 1,
      quoteReply: true,
      enableRobotAt: true,
      enableMarkdown: true,
      enableSuggestedResponses: true,
      forwardReasoning: true,
      blockWords: [],
      promptBlockWords: [],
      tts: {
        enabled: false,
        mode: 'vits-uma-genshin-honkai',
        activeVoice: 'fixture',
        alsoSendText: false,
        autoFallbackThreshold: 299,
        filter: null,
        azureEmotionEnabled: false
      },
      picture: {
        userEnabled: false,
        autoEnabled: false,
        autoThreshold: 1200,
        deviceScaleFactor: 1,
        closeBrowserAfterRender: true,
        showQRCode: true,
        live2d: null
      }
    },
    citationForwards: [{ title: 'fixture source', text: 'fixture citation' }],
    suggestions: ['fixture suggestion'],
    hooks: {
      postprocess: async ({ text }) => ({
        text,
        reasoningView: { text: 'fixture reasoning', truncated: false }
      }),
      convertText: async ({ text }) => [{ kind: 'text', text }],
      notifyResponsePost: value => notifications.push(value)
    }
  })

  assert.equal(result.outcome, 'complete')
  assert.deepEqual(calls.map(call => call.part.media), ['forward', 'text', 'forward', 'text'])
  assert.deepEqual(calls.map(call => call.options?.quoteMessageId), [undefined, 'request-1', undefined, undefined])
  assert.deepEqual(calls[3].part.buttons, {
    schemaVersion: 1,
    kind: 'chat_suggestions',
    suggestions: ['fixture suggestion']
  })
  assert.deepEqual(notifications, [{
    runRef,
    text: 'fixture response',
    hasReasoning: true
  }])
})
