import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  presentTtsReply,
  TTS_LONG_TEXT_NOTICE
} from '../../dist/runtime/presentation/tts-reply-presentation.js'

const target = Object.freeze({
  botId: 'bot-1', scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
})

const baseSettings = Object.freeze({
  enabled: true,
  mode: 'vits-uma-genshin-honkai',
  activeVoice: 'voice',
  alsoSendText: false,
  autoFallbackThreshold: 299,
  filter: null,
  azureEmotionEnabled: false
})

function fakeRuntime ({ synthesis, deliveries = [] } = {}) {
  const syntheses = []
  const calls = []
  return {
    syntheses,
    calls,
    tts: {
      async synthesize (input) {
        syntheses.push(input)
        return synthesis ?? {
          kind: 'ready',
          audio: { kind: 'buffer', data: new Uint8Array([1]), mimeType: 'audio/ogg', byteLength: 1 }
        }
      }
    },
    diagnostics: {
      reportSynthesisFailure () {}
    },
    outboundFactory: {
      async forTarget () {
        return {
          target,
          async deliver (part, attempt, options) {
            calls.push({ part, attempt, options })
            return deliveries.shift() ?? {
              kind: 'sent', media: part.media, attempt,
              receipt: { schemaVersion: 1, media: part.media, messageId: `${part.media}-${attempt}` }
            }
          },
          async recall () { return { kind: 'recalled' } }
        }
      }
    }
  }
}

function bodies (calls) {
  return calls.flatMap(call => call.part.media === 'text'
    ? call.part.atoms.flatMap(atom => atom.kind === 'text' ? [atom.text] : [])
    : [])
}

test('typed TTS preserves legacy VITS long-text fallback without chat source coupling', async () => {
  const runtime = fakeRuntime()
  await presentTtsReply({
    text: 'legacy long body',
    target,
    settings: { ...baseSettings, autoFallbackThreshold: 1 }
  }, runtime)
  assert.equal(runtime.syntheses.length, 0)
  assert.deepEqual(bodies(runtime.calls), [TTS_LONG_TEXT_NOTICE, 'legacy long body'])
})

test('typed TTS text-first failure never duplicates the original body', async () => {
  for (const runtime of [
    fakeRuntime({ synthesis: { kind: 'failed_definite', code: 'synthesis_rejected' } }),
    fakeRuntime({ deliveries: [
      { kind: 'sent', media: 'text', attempt: 1, receipt: { schemaVersion: 1, media: 'text', messageId: 'text-1' } },
      { kind: 'failed_definite', media: 'voice', attempt: 1, code: 'invalid_part' }
    ] })
  ]) {
    await presentTtsReply({
      text: 'legacy original body',
      target,
      settings: { ...baseSettings, alsoSendText: true }
    }, runtime)
    assert.deepEqual(bodies(runtime.calls), ['legacy original body'])
  }
})
