import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import type { TtsMode } from '../../src/runtime/presentation/presentation-settings.js'
import {
  createYunzaiTtsReplyPort,
  TTS_SYNTHESIS_TIMEOUT_MS,
  type TtsSynthesisResult,
  type YunzaiTtsBackendPort
} from '../../src/runtime/presentation/yunzai-tts-reply-port.js'
import type { ToolResource } from '../../src/tools/visible-tool-support.js'

const groupTarget: SessionAddress = Object.freeze({
  botId: 'bot-1',
  scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
})

const groupUserTarget: SessionAddress = Object.freeze({
  botId: 'bot-1',
  scope: Object.freeze({ kind: 'group_user', groupId: 'group-1', userId: 'actor-1' })
})

const audio: ToolResource = Object.freeze({
  kind: 'buffer',
  data: new Uint8Array([1, 2, 3]),
  mimeType: 'audio/ogg',
  byteLength: 3
})

const ready = (): TtsSynthesisResult => Object.freeze({ kind: 'ready', audio })

test('TTS passes mode and activeVoice for VITS Azure and VoiceVox', async () => {
  const calls: Array<Readonly<{ mode: TtsMode; voice: string }>> = []
  const port = createYunzaiTtsReplyPort({
    targets: { forTarget: async () => 'default' },
    backend: {
      synthesize: async input => {
        calls.push(Object.freeze({ mode: input.mode, voice: input.voice }))
        return ready()
      }
    }
  })

  for (const [mode, voice] of [
    ['vits-uma-genshin-honkai', '纳西妲'],
    ['azure', 'zh-CN-XiaoxiaoNeural'],
    ['voicevox', '护士机器子T']
  ] as const) {
    assert.equal((await port.synthesize({
      target: groupTarget, text: '需要合成的正文', mode, voice
    })).kind, 'ready')
  }
  assert.deepEqual(calls, [
    { mode: 'vits-uma-genshin-honkai', voice: '纳西妲' },
    { mode: 'azure', voice: 'zh-CN-XiaoxiaoNeural' },
    { mode: 'voicevox', voice: '护士机器子T' }
  ])
})

test('TTS classifies pre-abort post-abort timeout and late synthesis exactly', async () => {
  let dispatches = 0
  let resolveLate: ((value: TtsSynthesisResult) => void) | undefined
  const backend: YunzaiTtsBackendPort = {
    synthesize: async () => {
      dispatches += 1
      return await new Promise<TtsSynthesisResult>(resolve => { resolveLate = resolve })
    }
  }
  const port = createYunzaiTtsReplyPort({
    targets: { forTarget: async () => 'default' },
    backend
  })
  const common = {
    target: groupTarget,
    text: '正文',
    mode: 'azure' as const,
    voice: 'voice'
  }

  const pre = new AbortController()
  pre.abort()
  assert.deepEqual(await port.synthesize(common, pre.signal), {
    kind: 'failed_definite', code: 'aborted_before_dispatch'
  })
  assert.equal(dispatches, 0)

  const post = new AbortController()
  const pending = port.synthesize(common, post.signal)
  await Promise.resolve()
  assert.equal(dispatches, 1)
  post.abort()
  assert.deepEqual(await pending, {
    kind: 'outcome_unknown', code: 'synthesis_abort_after_dispatch'
  })
  resolveLate?.(ready())
  await Promise.resolve()
  assert.equal(dispatches, 1)

  const throwing = createYunzaiTtsReplyPort({
    targets: { forTarget: async () => 'default' },
    backend: { synthesize: async () => { throw new Error('private endpoint credential') } }
  })
  assert.deepEqual(await throwing.synthesize(common), {
    kind: 'outcome_unknown', code: 'synthesis_exception'
  })

  const originalSetTimeout = globalThis.setTimeout
  const delays: number[] = []
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number) => {
    delays.push(delay ?? 0)
    return originalSetTimeout(callback, 0)
  }) as typeof setTimeout
  try {
    const never = createYunzaiTtsReplyPort({
      targets: { forTarget: async () => 'default' },
      backend: { synthesize: async () => await new Promise<TtsSynthesisResult>(() => undefined) }
    })
    assert.deepEqual(await never.synthesize(common), {
      kind: 'outcome_unknown', code: 'synthesis_timeout'
    })
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }
  assert.deepEqual(delays, [TTS_SYNTHESIS_TIMEOUT_MS])
})

test('TTS payload and result contain no endpoint config or host segment', async () => {
  let backendInput: object | undefined
  const port = createYunzaiTtsReplyPort({
    targets: { forTarget: async () => 'default' },
    backend: {
      synthesize: async input => {
        backendInput = input
        return {
          kind: 'ready',
          audio,
          endpoint: 'https://private.invalid',
          config: { apiKey: 'secret-key' },
          hostSegment: { type: 'record' }
        } as unknown as TtsSynthesisResult
      }
    }
  })
  const result = await port.synthesize({
    target: groupTarget,
    text: '正文',
    mode: 'azure',
    voice: 'voice',
    endpoint: 'https://caller-private.invalid',
    config: { token: 'secret-token' },
    hostSegment: { type: 'record' }
  } as unknown as Parameters<typeof port.synthesize>[0])

  assert.deepEqual(Reflect.ownKeys(backendInput ?? {}).sort(), [
    'mode', 'recordEncoding', 'text', 'voice'
  ])
  assert.deepEqual(result, { kind: 'ready', audio })
  assert.doesNotMatch(
    JSON.stringify({ backendInput, result }),
    /endpoint|config|hostSegment|secret-key|secret-token|private\.invalid/
  )

  for (const unsafeAudio of [
    { ...audio, byteLength: 99 },
    { ...audio, hostSegment: { type: 'record' } },
    { kind: 'local_path', path: '/tmp/audio.ogg', mimeType: 'audio/ogg', byteLength: 1, endpoint: 'private' }
  ]) {
    const malformed = createYunzaiTtsReplyPort({
      targets: { forTarget: async () => 'default' },
      backend: {
        synthesize: async () => ({
          kind: 'ready', audio: unsafeAudio
        } as unknown as TtsSynthesisResult)
      }
    })
    assert.deepEqual(await malformed.synthesize({
      target: groupTarget, text: '正文', mode: 'azure', voice: 'voice'
    }), { kind: 'outcome_unknown', code: 'synthesis_exception' })
  }
})

test('TTS projection exceptions after dispatch stay outcome unknown', async () => {
  let backendCalls = 0
  const maliciousBytes = new Proxy(new Uint8Array([1]), {
    getPrototypeOf: () => {
      throw new Error('private projection detail')
    }
  })
  const port = createYunzaiTtsReplyPort({
    targets: { forTarget: async () => 'default' },
    backend: {
      synthesize: async () => {
        backendCalls += 1
        return {
          kind: 'ready',
          audio: {
            kind: 'buffer',
            data: maliciousBytes,
            mimeType: 'audio/ogg',
            byteLength: 1
          }
        }
      }
    }
  })

  assert.deepEqual(await port.synthesize({
    target: groupTarget, text: '正文', mode: 'azure', voice: 'voice'
  }), { kind: 'outcome_unknown', code: 'synthesis_exception' })
  assert.equal(backendCalls, 1)
})

test('TTS derives only target encoding and activeVoice without retaining an event', async () => {
  const targets: SessionAddress[] = []
  const backendInputs: object[] = []
  const port = createYunzaiTtsReplyPort({
    targets: {
      forTarget: async target => {
        targets.push(target)
        return target.botId === 'bot-1' ? 'shamrock_passthrough' : 'unavailable'
      }
    },
    backend: {
      synthesize: async input => {
        backendInputs.push(input)
        return ready()
      }
    }
  })

  const result = await port.synthesize({
    target: groupUserTarget,
    text: ' 正文 ',
    mode: 'voicevox',
    voice: ' active voice ',
    event: { sender: { user_id: 'actor-1' }, raw_message: 'private prompt' }
  } as unknown as Parameters<typeof port.synthesize>[0])
  assert.equal(result.kind, 'ready')
  assert.deepEqual(targets, [{
    botId: 'bot-1', scope: { kind: 'group', groupId: 'group-1' }
  }])
  assert.deepEqual(backendInputs, [{
    text: '正文',
    mode: 'voicevox',
    voice: 'active voice',
    recordEncoding: 'shamrock_passthrough'
  }])
  assert.doesNotMatch(JSON.stringify({ targets, backendInputs, result }), /actor-1|private prompt|event/)

  assert.deepEqual(await port.synthesize({
    target: Object.freeze({
      botId: 'bot-missing', scope: Object.freeze({ kind: 'private', userId: 'user-1' })
    }),
    text: '正文',
    mode: 'azure',
    voice: 'voice'
  }), { kind: 'failed_definite', code: 'synthesis_rejected' })
  assert.equal(backendInputs.length, 1)

  let rejectedBackendCalls = 0
  let rejectedTargetCalls = 0
  const rejected = createYunzaiTtsReplyPort({
    targets: {
      forTarget: async value => {
        rejectedTargetCalls += 1
        if (value.botId === 'throw') throw new Error('private resolver detail')
        return 'default'
      }
    },
    backend: {
      synthesize: async () => {
        rejectedBackendCalls += 1
        return ready()
      }
    }
  })
  const base = { target: groupTarget, text: '正文', mode: 'azure', voice: 'voice' } as const
  for (const [value, expected] of [
    [{ ...base, text: '   ' }, { kind: 'failed_definite', code: 'empty_after_filter' }],
    [{ ...base, mode: 'forged' }, { kind: 'failed_definite', code: 'unsupported_mode' }],
    [{ ...base, voice: '' }, { kind: 'failed_definite', code: 'unsupported_voice' }],
    [{ ...base, voice: 'x'.repeat(257) }, { kind: 'failed_definite', code: 'unsupported_voice' }],
    [{ ...base, emotion: '' }, { kind: 'failed_definite', code: 'synthesis_rejected' }],
    [{ ...base, emotion: 'x'.repeat(65) }, { kind: 'failed_definite', code: 'synthesis_rejected' }],
    [{ ...base, emotion: 'cheerful', emotionDegree: 0 }, { kind: 'failed_definite', code: 'synthesis_rejected' }],
    [{ ...base, emotion: 'cheerful', emotionDegree: 2.01 }, { kind: 'failed_definite', code: 'synthesis_rejected' }],
    [{ ...base, target: { botId: '', scope: { kind: 'group', groupId: 'group-1' } } }, { kind: 'failed_definite', code: 'synthesis_rejected' }],
    [{ ...base, target: { botId: 'throw', scope: { kind: 'group', groupId: 'group-1' } } }, { kind: 'failed_definite', code: 'synthesis_rejected' }]
  ] as const) {
    assert.deepEqual(
      await rejected.synthesize(value as unknown as Parameters<typeof rejected.synthesize>[0]),
      expected
    )
  }
  const preAborted = new AbortController()
  preAborted.abort()
  assert.deepEqual(await rejected.synthesize(base, preAborted.signal), {
    kind: 'failed_definite', code: 'aborted_before_dispatch'
  })
  assert.equal(rejectedBackendCalls, 0)
  assert.equal(rejectedTargetCalls, 1)
})
