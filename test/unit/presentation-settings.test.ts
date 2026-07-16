import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createPresentationSettingsPort,
  type PresentationSettingsSource,
  type TtsMode
} from '../../src/runtime/presentation/presentation-settings.js'

function safeConfig (
  overrides: Partial<ReturnType<PresentationSettingsSource['currentSafeConfig']>> = {}
): ReturnType<PresentationSettingsSource['currentSafeConfig']> {
  return {
    quoteReply: true,
    enableRobotAt: true,
    enableMd: false,
    enableSuggestedResponses: true,
    forwardReasoning: true,
    blockWords: [' Alpha ', 'A\u030A', '', 'Alpha'],
    promptBlockWords: [' Prompt '],
    defaultUsePicture: false,
    defaultUseTTS: false,
    defaultTTSRole: ' 纳西妲 ',
    azureTTSSpeaker: ' zh-CN-XiaochenNeural ',
    voicevoxTTSSpeaker: ' 护士机器子T ',
    ttsMode: 'vits-uma-genshin-honkai',
    alsoSendText: false,
    ttsAutoFallbackThreshold: 299,
    ttsRegex: '/secret/gi',
    enhanceAzureTTSEmotion: false,
    autoUsePicture: true,
    autoUsePictureThreshold: 1200,
    cloudDPR: 1,
    closeBrowserAfterRender: true,
    showQRCode: true,
    live2d: false,
    live2dModel: '/live2d/model.json',
    live2dOption_scale: 0.1,
    live2dOption_positionX: 0,
    live2dOption_positionY: 0,
    live2dOption_rotation: 0,
    live2dOption_alpha: 1,
    ...overrides
  }
}

function source (input: {
  readonly userJson?: string | null
  readonly mode?: TtsMode
  readonly overrides?: Partial<ReturnType<PresentationSettingsSource['currentSafeConfig']>>
} = {}): PresentationSettingsSource {
  return {
    loadUserJson: async () => input.userJson ?? null,
    currentSafeConfig: () => safeConfig({
      ...(input.overrides ?? {}),
      ...(input.mode === undefined ? {} : { ttsMode: input.mode })
    })
  }
}

test('presentation settings keep only the safe allowlist', async () => {
  const settings = await createPresentationSettingsPort(source({
    userJson: JSON.stringify({
      usePicture: true,
      useTTS: 'true',
      ttsRole: ' 旅行者 ',
      ttsRoleAzure: 7,
      ttsRoleVoiceVox: ' ずんだもん ',
      apiKey: 'sk-secret',
      viewHost: 'private.example',
      cloudTranscode: 'https://private.example',
      cookie: 'secret-cookie',
      model: 'private-model',
      inputReplySnapshot: { text: 'private quoted body' }
    }),
    overrides: {
      ttsAutoFallbackThreshold: 99_999,
      autoUsePictureThreshold: -10,
      cloudDPR: 9,
      live2d: true,
      live2dModel: ` ${'m'.repeat(700)} `,
      live2dOption_scale: 12,
      live2dOption_positionX: -9000,
      live2dOption_positionY: 9000,
      live2dOption_rotation: 720,
      live2dOption_alpha: -1,
      blockWords: [
        ...Array.from({ length: 260 }, (_, index) => ` word-${index} `),
        'word-0'
      ]
    } as Partial<ReturnType<PresentationSettingsSource['currentSafeConfig']>>
  })).load('actor-1')

  assert.deepEqual(Reflect.ownKeys(settings), [
    'schemaVersion', 'quoteReply', 'enableRobotAt', 'enableMarkdown',
    'enableSuggestedResponses', 'forwardReasoning', 'blockWords',
    'promptBlockWords', 'tts', 'picture'
  ])
  assert.equal(settings.picture.userEnabled, true)
  assert.equal(settings.tts.enabled, false)
  assert.equal(settings.tts.activeVoice, '旅行者')
  assert.equal(settings.tts.autoFallbackThreshold, 24_000)
  assert.equal(settings.picture.autoThreshold, 1)
  assert.equal(settings.picture.deviceScaleFactor, 4)
  assert.equal(settings.picture.live2d?.modelPath, '/live2d/Murasame/Murasame.model3.json')
  assert.deepEqual(settings.picture.live2d, {
    modelPath: '/live2d/Murasame/Murasame.model3.json',
    scale: 10,
    positionX: -4096,
    positionY: 4096,
    rotation: 360,
    alpha: 0
  })
  assert.equal(settings.blockWords.length, 256)
  assert.equal(settings.blockWords[0], 'word-0')
  assert.deepEqual(settings.promptBlockWords, ['Prompt'])
  assert.equal(Object.isFrozen(settings), true)
  assert.equal(Object.isFrozen(settings.tts), true)
  assert.equal(Object.isFrozen(settings.picture), true)
  assert.equal(Object.isFrozen(settings.blockWords), true)

  const serialized = JSON.stringify(settings)
  for (const forbiddenKey of [
    'apiKey', 'viewHost', 'cloudTranscode', 'cookie', 'model', 'inputReplySnapshot'
  ]) {
    assert.equal(serialized.includes(`"${forbiddenKey}":`), false)
  }
  for (const forbiddenValue of [
    'sk-secret', 'private.example', 'private-model', 'private quoted body'
  ]) {
    assert.equal(serialized.includes(forbiddenValue), false)
  }
})

test('presentation settings select the active TTS role without exposing endpoints', async () => {
  const modes: ReadonlyArray<readonly [TtsMode, string, string]> = [
    ['vits-uma-genshin-honkai', '草神', 'ttsRole'],
    ['azure', 'zh-CN-YunxiNeural', 'ttsRoleAzure'],
    ['voicevox', '四国めたん', 'ttsRoleVoiceVox']
  ]

  for (const [mode, activeVoice, key] of modes) {
    const settings = await createPresentationSettingsPort(source({
      mode,
      userJson: JSON.stringify({
        useTTS: true,
        ttsRole: '草神',
        ttsRoleAzure: 'zh-CN-YunxiNeural',
        ttsRoleVoiceVox: '四国めたん',
        endpoint: `https://${key}.private.example`,
        azureTTSKey: 'secret'
      })
    })).load('actor-1')
    assert.equal(settings.tts.mode, mode)
    assert.equal(settings.tts.activeVoice, activeVoice)
    assert.deepEqual(settings.tts.filter, { source: 'secret', flags: 'gi' })
    assert.doesNotMatch(JSON.stringify(settings), /private\.example|azureTTSKey/)
  }

  const invalidFilter = await createPresentationSettingsPort(source({
    overrides: { ttsRegex: '/secret/gg' }
  })).load('actor-1')
  assert.equal(invalidFilter.tts.filter, null)
})
