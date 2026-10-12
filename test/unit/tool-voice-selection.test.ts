import assert from 'node:assert/strict'
import { test } from 'node:test'
import { selectToolVoice } from '../../src/runtime/tools/tool-voice-selection.js'
import { createYunzaiTtsReplyPort, ttsTargetEncoding } from '../../src/runtime/presentation/yunzai-tts-reply-port.js'

const options = { requested: '', mode: 'vits-uma-genshin-honkai' as const, activeVoice: 'fixture-voice',
  vits: ['fixture-voice'], azure: [{ name: 'Azure voice', code: 'fixture-code' }],
  voicevox: [{ name: 'Vox voice', styles: [{ name: 'normal' }] }] }

test('blank/default tool voice resolves to the active user preference before synthesis', () => {
  for (const requested of ['', '默认', 'default', 'Default']) assert.equal(selectToolVoice({ ...options, requested }), 'fixture-voice')
})

test('unsupported voices fail locally and valid backend-specific names retain their meaning', () => {
  assert.equal(selectToolVoice({ ...options, requested: 'nonexistent' }), null)
  assert.equal(selectToolVoice({ ...options, requested: '随机' }), '随机')
  assert.equal(selectToolVoice({ ...options, mode: 'azure', requested: 'Azure voice' }), 'fixture-code')
  assert.equal(selectToolVoice({ ...options, mode: 'voicevox', requested: 'Vox voice-normal' }), 'Vox voice-normal')
  assert.equal(selectToolVoice({ ...options, mode: 'voicevox', requested: 'Vox voice-unknown' }), null)
})

test('OneBot audio uses adapter-native encoding while OICQ and Shamrock retain their path', () => {
  assert.equal(ttsTargetEncoding('OneBotv11'), 'adapter_native')
  assert.equal(ttsTargetEncoding('NapCat'), 'adapter_native')
  assert.equal(ttsTargetEncoding('icqq'), 'default')
  assert.equal(ttsTargetEncoding('Shamrock'), 'shamrock_passthrough')
})

test('adapter-native encoding crosses the typed synthesis port and returns bounded raw audio', async () => {
  let calls = 0
  const port = createYunzaiTtsReplyPort({ targets: { forTarget: async () => 'adapter_native' },
    backend: { synthesize: async input => {
      calls++
      assert.equal(input.recordEncoding, 'adapter_native')
      return { kind: 'ready', audio: { kind: 'buffer', data: Buffer.from('synthetic-wav'), byteLength: 13, mimeType: 'audio/wav' } }
    } } })
  const result = await port.synthesize({ target: { botId: '10000', scope: { kind: 'group', groupId: '9' } },
    text: 'synthetic', mode: 'vits-uma-genshin-honkai', voice: 'fixture-voice' })
  assert.equal(result.kind, 'ready')
  assert.equal(calls, 1)
})
