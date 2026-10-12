import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveToolVoice, selectToolVoice } from '../../src/runtime/tools/tool-voice-selection.js'
import { createYunzaiTtsReplyPort, ttsTargetEncoding } from '../../src/runtime/presentation/yunzai-tts-reply-port.js'
import { createPresentationSettingsPort } from '../../src/runtime/presentation/presentation-settings.js'

const options = { requested: '', mode: 'vits-uma-genshin-honkai' as const, activeVoice: 'fixture-voice',
  vits: ['fixture-voice'], azure: [{ name: 'Azure voice', code: 'fixture-code' }],
  voicevox: [{ name: 'Vox voice', styles: [{ name: 'normal' }] }] }

test('tool voice loads the actual presentation port and honors the current actor override', async () => {
  const settings = createPresentationSettingsPort({
    currentSafeConfig: () => ({
      quoteReply: true, enableRobotAt: false, enableMd: false,
      enableSuggestedResponses: false, forwardReasoning: false,
      blockWords: [], promptBlockWords: [], defaultUsePicture: false, defaultUseTTS: false,
      ttsMode: options.mode, defaultTTSRole: 'fixture-voice', azureTTSSpeaker: 'fixture-code',
      voicevoxTTSSpeaker: 'Vox voice', alsoSendText: false, ttsAutoFallbackThreshold: 299,
      ttsRegex: '', enhanceAzureTTSEmotion: false, autoUsePicture: false,
      autoUsePictureThreshold: 1200, cloudDPR: 1, closeBrowserAfterRender: true,
      showQRCode: false, live2d: false, live2dModel: '', live2dOption_scale: 1,
      live2dOption_positionX: 0, live2dOption_positionY: 0, live2dOption_rotation: 0,
      live2dOption_alpha: 1
    }),
    loadUserJson: async actorId => {
      assert.equal(actorId, 'fixture-actor')
      return JSON.stringify({ ttsRole: 'user-voice' })
    }
  })
  assert.equal(await resolveToolVoice({ ...options, actorId: 'fixture-actor', settings,
    vits: ['fixture-voice', 'user-voice'] }), 'user-voice')
  assert.equal(await resolveToolVoice({ ...options, actorId: 'fixture-actor', settings }), null)
})

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
