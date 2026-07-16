import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import type {
  DeliveryResult,
  PresentationDeliveryMedia,
  RuntimeDeliveryReceipt
} from '../../src/runtime/presentation/presentation-result.js'
import type { TtsPresentationSettings } from '../../src/runtime/presentation/presentation-settings.js'
import {
  presentTtsReply,
  TTS_LONG_TEXT_NOTICE,
  type TtsPresentationDiagnosticPort
} from '../../src/runtime/presentation/tts-reply-presentation.js'
import type {
  TtsReplyPort,
  TtsSynthesisErrorCode,
  TtsSynthesisResult
} from '../../src/runtime/presentation/yunzai-tts-reply-port.js'
import type {
  OutboundDeliveryOptions,
  OutboundPart,
  YunzaiOutboundPortFactory
} from '../../src/runtime/presentation/yunzai-outbound-port.js'
import type { ToolResource } from '../../src/tools/visible-tool-support.js'

const target: SessionAddress = Object.freeze({
  botId: 'bot-1', scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
})

const audio: ToolResource = Object.freeze({
  kind: 'buffer', data: new Uint8Array([7]), mimeType: 'audio/ogg', byteLength: 1
})

function settings (overrides: Partial<TtsPresentationSettings> = {}): TtsPresentationSettings {
  return Object.freeze({
    enabled: true,
    mode: 'vits-uma-genshin-honkai',
    activeVoice: 'voice',
    alsoSendText: false,
    autoFallbackThreshold: 299,
    filter: null,
    azureEmotionEnabled: false,
    ...overrides
  })
}

function sent (
  media: PresentationDeliveryMedia,
  attempt: 1 | 2 = 1
): DeliveryResult<typeof media> {
  return Object.freeze({
    kind: 'sent', media, attempt,
    receipt: Object.freeze({
      schemaVersion: 1, media, messageId: `${media}-${attempt}`
    }) as RuntimeDeliveryReceipt<typeof media>
  })
}

function definite (
  media: PresentationDeliveryMedia,
  attempt: 1 | 2 = 1
): DeliveryResult<typeof media> {
  return Object.freeze({ kind: 'failed_definite', media, attempt, code: 'host_rejected' })
}

function unknown (
  media: PresentationDeliveryMedia,
  attempt: 1 | 2 = 1
): DeliveryResult<typeof media> {
  return Object.freeze({ kind: 'outcome_unknown', media, attempt, code: 'unknown_host_result' })
}

function invalid (
  media: PresentationDeliveryMedia,
  attempt: 1 | 2 = 1
): DeliveryResult<typeof media> {
  return Object.freeze({ kind: 'failed_definite', media, attempt, code: 'invalid_part' })
}

function fixture (input: {
  readonly synthesis?: TtsSynthesisResult
  readonly deliveries?: DeliveryResult<PresentationDeliveryMedia>[]
  readonly diagnostic?: (code: TtsSynthesisErrorCode) => void | Promise<void>
} = {}) {
  const calls: Array<Readonly<{
    part: OutboundPart
    attempt: 1 | 2
    options: OutboundDeliveryOptions | undefined
  }>> = []
  const synthesisCalls: object[] = []
  const diagnosticCalls: TtsSynthesisErrorCode[] = []
  const deliveries = [...(input.deliveries ?? [])]
  const tts: TtsReplyPort = {
    synthesize: async value => {
      synthesisCalls.push(value)
      return input.synthesis ?? Object.freeze({ kind: 'ready', audio })
    }
  }
  const outboundFactory: YunzaiOutboundPortFactory = {
    forTarget: async address => ({
      target: address,
      deliver: async (part, attempt, options) => {
        calls.push(Object.freeze({ part, attempt, options }))
        return (deliveries.shift() ?? sent(
          part.media as PresentationDeliveryMedia,
          attempt
        )) as DeliveryResult<typeof part.media>
      },
      recall: async () => Object.freeze({ kind: 'recalled' })
    })
  }
  const diagnostics: TtsPresentationDiagnosticPort = {
    reportSynthesisFailure: code => {
      diagnosticCalls.push(code)
      return input.diagnostic?.(code)
    }
  }
  return { tts, outboundFactory, diagnostics, calls, synthesisCalls, diagnosticCalls }
}

function textBodies (calls: readonly { readonly part: OutboundPart }[]): string[] {
  return calls.flatMap(call => call.part.media === 'text'
    ? call.part.atoms.flatMap(atom => atom.kind === 'text' ? [atom.text] : [])
    : [])
}

async function captureUnhandledRejections (action: () => Promise<void>): Promise<readonly unknown[]> {
  const unhandled: unknown[] = []
  const listener = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', listener)
  try {
    await action()
    await new Promise<void>(resolve => setImmediate(resolve))
  } finally {
    process.off('unhandledRejection', listener)
  }
  return Object.freeze(unhandled)
}

test('VITS over threshold sends notice and original text without synthesis', async () => {
  const f = fixture()
  const result = await presentTtsReply({
    text: '超过阈值的原始正文',
    target,
    settings: settings({ autoFallbackThreshold: 1 }),
    quoteMessageId: 'request-1'
  }, f)
  assert.equal(result.outcome, 'complete')
  assert.equal(f.synthesisCalls.length, 0)
  assert.deepEqual(f.diagnosticCalls, [])
  assert.deepEqual(textBodies(f.calls), [TTS_LONG_TEXT_NOTICE, '超过阈值的原始正文'])
  assert.deepEqual(f.calls.map(call => call.options?.quoteMessageId), [undefined, 'request-1'])
})

test('text-first records text and voice as independent deliveries', async () => {
  const f = fixture({ deliveries: [sent('text'), definite('voice'), definite('voice', 2)] })
  const result = await presentTtsReply({
    text: '先发送文本', target, settings: settings({ alsoSendText: true })
  }, f)
  assert.equal(result.outcome, 'partial')
  assert.deepEqual(result.deliveries.map(item => [item.media, item.kind, item.attempt]), [
    ['text', 'sent', 1],
    ['voice', 'failed_definite', 2]
  ])
  assert.deepEqual(f.calls.map(call => call.part.media), ['text', 'voice', 'voice'])

  const azure = fixture({ deliveries: [sent('text'), sent('voice')] })
  await presentTtsReply({
    text: '[cheerful, 3.5] 可见DROP🙂-\n正文 [sad, 0]',
    target,
    settings: settings({
      mode: 'azure',
      activeVoice: 'zh-CN-XiaoxiaoNeural',
      alsoSendText: true,
      filter: Object.freeze({ source: 'DROP', flags: 'gi' }),
      azureEmotionEnabled: true
    })
  }, azure)
  assert.deepEqual(azure.synthesisCalls, [{
    target,
    text: '可见，，正文',
    mode: 'azure',
    voice: 'zh-CN-XiaoxiaoNeural',
    emotion: 'cheerful',
    emotionDegree: 2
  }])
  assert.deepEqual(textBodies(azure.calls), ['可见DROP🙂-\n正文'])
})

test('text-first never duplicates text after synthesis or voice failure', async () => {
  for (const [synthesis, textDeliveries, expected, expectedDelivery] of [
    [Object.freeze({ kind: 'failed_definite', code: 'synthesis_rejected' }), [sent('text')], 'partial', sent('text')],
    [Object.freeze({ kind: 'outcome_unknown', code: 'synthesis_exception' }), [invalid('text')], 'failed', invalid('text')],
    [Object.freeze({ kind: 'outcome_unknown', code: 'synthesis_timeout' }), [unknown('text')], 'unknown', unknown('text')]
  ] as const) {
    const f = fixture({ synthesis, deliveries: [...textDeliveries] })
    const result = await presentTtsReply({
      text: '唯一原始正文', target, settings: settings({ alsoSendText: true })
    }, f)
    assert.equal(result.outcome, expected)
    assert.deepEqual(result.deliveries, [expectedDelivery])
    assert.deepEqual(textBodies(f.calls), ['唯一原始正文'])
    assert.equal(f.calls.some(call => call.part.media === 'voice'), false)
    assert.deepEqual(f.diagnosticCalls, [synthesis.code])
    assert.doesNotMatch(JSON.stringify({ result, calls: f.calls }), /合成语音发生错误/)
  }

  const voiceUnknown = fixture({ deliveries: [sent('text'), unknown('voice')] })
  const voiceResult = await presentTtsReply({
    text: '唯一原始正文', target, settings: settings({ alsoSendText: true })
  }, voiceUnknown)
  assert.equal(voiceResult.outcome, 'partial')
  assert.deepEqual(voiceResult.deliveries.map(item => item.media), ['text', 'voice'])
  assert.deepEqual(textBodies(voiceUnknown.calls), ['唯一原始正文'])
})

test('pre-send synthesis failure falls back to original text once', async () => {
  for (const synthesis of [
    Object.freeze({ kind: 'failed_definite' as const, code: 'unsupported_voice' as const }),
    Object.freeze({ kind: 'outcome_unknown' as const, code: 'synthesis_timeout' as const })
  ]) {
    const f = fixture({ synthesis })
    const result = await presentTtsReply({
      text: '单次文本降级',
      target,
      settings: settings(),
      quoteMessageId: 'request-1'
    }, f)
    assert.equal(result.outcome, 'complete')
    assert.deepEqual(textBodies(f.calls), ['单次文本降级'])
    assert.deepEqual(f.calls.map(call => call.options?.quoteMessageId), ['request-1'])
    assert.deepEqual(f.diagnosticCalls, [synthesis.code])
  }
})

test('definite voice rejection falls back once while unknown delivery does not', async () => {
  const rejected = fixture({
    deliveries: [definite('voice'), definite('voice', 2), sent('text')]
  })
  const rejectedResult = await presentTtsReply({
    text: '语音失败文本降级',
    target,
    settings: settings(),
    quoteMessageId: 'request-1'
  }, rejected)
  assert.equal(rejectedResult.outcome, 'partial')
  assert.deepEqual(rejectedResult.deliveries.map(item => [item.media, item.kind]), [
    ['voice', 'failed_definite'], ['text', 'sent']
  ])
  assert.deepEqual(textBodies(rejected.calls), ['语音失败文本降级'])
  assert.deepEqual(rejected.calls.map(call => call.options?.quoteMessageId), [
    undefined, undefined, 'request-1'
  ])

  const indeterminate = fixture({ deliveries: [unknown('voice')] })
  const unknownResult = await presentTtsReply({
    text: '不应重复的正文', target, settings: settings()
  }, indeterminate)
  assert.equal(unknownResult.outcome, 'unknown')
  assert.deepEqual(indeterminate.calls.map(call => call.part.media), ['voice'])
  assert.deepEqual(textBodies(indeterminate.calls), [])
})

test('TTS diagnostics expose only one fixed code and isolate callback failures', async () => {
  for (const diagnostic of [
    () => { throw new Error('private endpoint target text config') },
    async () => { throw new Error('private async endpoint target text config') }
  ]) {
    const f = fixture({
      synthesis: Object.freeze({
        kind: 'outcome_unknown', code: 'synthesis_exception'
      }),
      diagnostic
    })
    let outcome: string | undefined
    const unhandled = await captureUnhandledRejections(async () => {
      outcome = (await presentTtsReply({
        text: 'PRIVATE-BODY',
        target,
        settings: settings({ activeVoice: 'PRIVATE-VOICE' })
      }, f)).outcome
    })
    assert.equal(outcome, 'complete')
    assert.deepEqual(f.diagnosticCalls, ['synthesis_exception'])
    assert.deepEqual(unhandled, [])
    assert.deepEqual(Reflect.ownKeys(f.diagnostics), ['reportSynthesisFailure'])
    assert.doesNotMatch(JSON.stringify(f.diagnosticCalls), /PRIVATE|endpoint|target|config/i)
  }

  const empty = fixture()
  await presentTtsReply({
    text: 'FILTER-ME',
    target,
    settings: settings({
      filter: Object.freeze({ source: 'FILTER-ME', flags: 'g' })
    })
  }, empty)
  assert.equal(empty.synthesisCalls.length, 0)
  assert.deepEqual(empty.diagnosticCalls, ['empty_after_filter'])
})
