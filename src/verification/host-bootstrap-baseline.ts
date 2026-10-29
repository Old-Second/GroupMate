// Captures the pre-migration behaviour of the host bootstrap helpers that `index.js` used to own,
// so the TypeScript replacements can be held to it row by row. The legacy source is read from a
// pinned commit rather than the working tree: that keeps this reproducible after the helpers are
// deleted from `index.js`, which is the whole point of a migration baseline.
import {
  encodeValue,
  legacyIndexSource,
  sliceBlock,
  sourceSha256,
  writeFixture,
  type Encoded
} from './host-bootstrap-fixture.js'

export {
  decodeValue,
  encodeValue,
  serializeFixture,
  type Encoded
} from './host-bootstrap-fixture.js'

export const BASELINE_COMMIT = '5bf84e2c05f43c118f28ca0d21480a0474708203'
export const FIXTURE_PATH = 'test/fixtures/host-bootstrap/batch-1-config-projection.json'

export interface LegacyHostApi {
  normalizedText: (value: unknown, maximum: number, fallback?: string) => string
  normalizedStringList: (
    value: unknown, maximumItems?: number, maximumCharacters?: number
  ) => readonly string[]
  finiteInteger: (value: unknown, fallback: number, minimum: number, maximum: number) => number
  finiteNumber: (value: unknown, fallback: number, minimum: number, maximum: number) => number
  configuredThinkingMode: (value: unknown) => string
  configuredReasoningEffort: (value: unknown) => string
  ttsMode: () => string
  currentPresentationConfig: () => unknown
  defaultPreferences: () => unknown
  parsePreferenceRecord: (raw: unknown) => Record<string, unknown>
  projectPreferences: (record: Readonly<Record<string, unknown>>) => unknown
  buttonPolicy: { snapshot: () => unknown }
  bymPolicy: { snapshot: () => unknown }
}

const FUNCTION_SLICES: readonly string[] = Object.freeze([
  'normalizedText', 'normalizedStringList', 'finiteInteger', 'finiteNumber',
  'configuredThinkingMode', 'configuredReasoningEffort', 'ttsMode',
  'currentPresentationConfig', 'defaultPreferences', 'parsePreferenceRecord',
  'projectPreferences'
])
const FROZEN_SLICES: readonly string[] = Object.freeze(['buttonPolicy', 'bymPolicy'])

function sliceFunction (source: string, name: string): string {
  return sliceBlock(source, `\nfunction ${name} (`, '\n}\n', name)
}

export function legacyHostApi (source: string, config: unknown): LegacyHostApi {
  const blocks = [
    ...FUNCTION_SLICES.map(name => sliceFunction(source, name)),
    ...FROZEN_SLICES.map(
      name => sliceBlock(source, `\nconst ${name} = Object.freeze({`, '\n})\n', name)
    )
  ]
  const names = [...FUNCTION_SLICES, ...FROZEN_SLICES].join(', ')
  const factory = new Function('Config', `${blocks.join('\n')}\nreturn { ${names} }`) as
    (hostConfig: unknown) => LegacyHostApi
  return factory(config)
}

const DECOMPOSED = 'é̂cole'
const EMOJI = '👩‍👩‍👧‍👦🙂'

export const CONFIG_FIXTURES: Readonly<Record<string, Readonly<Record<string, unknown>>>> =
  Object.freeze({
    empty: Object.freeze({}),
    configured: Object.freeze({
      quoteReply: true, enableRobotAt: true, enableMd: true, enableSuggestedResponses: true,
      forwardReasoning: true, blockWords: ['禁词', '另一个'], promptBlockWords: ['提示禁词'],
      defaultUsePicture: true, defaultUseTTS: true, defaultTTSRole: '胡桃',
      azureTTSSpeaker: 'zh-CN-XiaoxiaoNeural', voicevoxTTSSpeaker: '四国めたん',
      ttsMode: 'azure', alsoSendText: true, ttsAutoFallbackThreshold: 420, ttsRegex: '^读.*',
      enhanceAzureTTSEmotion: true, autoUsePicture: true, autoUsePictureThreshold: 900,
      cloudDPR: 2, closeBrowserAfterRender: true, showQRCode: true, live2d: true,
      live2dModel: '/live2d/Other/Other.model3.json', live2dOption_scale: 1.5,
      live2dOption_positionX: 12, live2dOption_positionY: -12, live2dOption_rotation: 45,
      live2dOption_alpha: 0.5, apiKey: 'sk-f', openAiBaseUrl: 'https://fixture.invalid/v1',
      model: 'fixture-model', enableBYM: true, assistantLabel: '小助手',
      bymRecognizeLeadingAlias: true, bymRate: 42, bymDisableGroup: ['1', '2'],
      bymThinkingMode: 'enabled', bymReasoningEffort: 'high', bymPreset: '预设',
      bymFuckList: ['骂', '回骂'], bymFuckBlacklist: ['9'], bymFuckPrompt: '回击提示',
      bymFuckRecall: true, bymFuckRecallTime: 200
    }),
    wrongTypes: Object.freeze({
      quoteReply: 'true', enableRobotAt: 1, enableMd: 'yes', enableSuggestedResponses: {},
      forwardReasoning: 0, blockWords: 42, promptBlockWords: { a: 1 },
      defaultUsePicture: 'false', defaultUseTTS: null, defaultTTSRole: 7,
      azureTTSSpeaker: [], voicevoxTTSSpeaker: null, ttsMode: 'Azure', alsoSendText: 'on',
      ttsAutoFallbackThreshold: '420', ttsRegex: 7, enhanceAzureTTSEmotion: 'true',
      autoUsePicture: 'false', autoUsePictureThreshold: null, cloudDPR: '2',
      closeBrowserAfterRender: 'false', showQRCode: 0, live2d: 'true', live2dModel: 9,
      live2dOption_scale: '1.5', live2dOption_positionX: null, live2dOption_positionY: [],
      live2dOption_rotation: {}, live2dOption_alpha: 'x', apiKey: 12_345,
      openAiBaseUrl: null, model: [], enableBYM: 'true', assistantLabel: 0,
      bymRecognizeLeadingAlias: 0, bymRate: '42', bymDisableGroup: 1,
      bymThinkingMode: 'ENABLED', bymReasoningEffort: 'highest', bymPreset: null,
      bymFuckList: 'single', bymFuckBlacklist: {}, bymFuckPrompt: 3,
      bymFuckRecall: 'true', bymFuckRecallTime: '200'
    }),
    boundaryLow: Object.freeze({
      quoteReply: false, enableRobotAt: false, forwardReasoning: false, autoUsePicture: false,
      closeBrowserAfterRender: false, showQRCode: false, bymRecognizeLeadingAlias: false,
      blockWords: [], promptBlockWords: [], bymDisableGroup: [], bymFuckList: [],
      bymFuckBlacklist: [], defaultTTSRole: '', azureTTSSpeaker: '   ',
      voicevoxTTSSpeaker: '　', assistantLabel: '', bymPreset: '  ', ttsRegex: '',
      apiKey: '', openAiBaseUrl: '   ', model: '',
      ttsAutoFallbackThreshold: 0, autoUsePictureThreshold: -5, cloudDPR: 0.1,
      live2dOption_scale: -1, live2dOption_positionX: -5_000, live2dOption_positionY: -4_096,
      live2dOption_rotation: -361, live2dOption_alpha: -0, bymRate: -1, bymFuckRecallTime: 0
    }),
    boundaryHigh: Object.freeze({
      ttsAutoFallbackThreshold: 24_001, autoUsePictureThreshold: Number.POSITIVE_INFINITY,
      cloudDPR: Number.NaN, live2dOption_scale: 10.5, live2dOption_positionX: 4_096.9,
      live2dOption_positionY: Number.NEGATIVE_INFINITY, live2dOption_rotation: 360.5,
      live2dOption_alpha: 1.5, bymRate: 101, bymFuckRecallTime: 3_601,
      defaultTTSRole: 'ロ'.repeat(600), bymPreset: '预'.repeat(9_000),
      bymFuckPrompt: '击'.repeat(20_000), apiKey: 'k'.repeat(20_000),
      blockWords: Array.from({ length: 300 }, (_, index) => `w${index}`),
      bymFuckList: Array.from({ length: 130 }, (_, index) => `f${index}`)
    }),
    unicode: Object.freeze({
      defaultTTSRole: DECOMPOSED, azureTTSSpeaker: EMOJI, voicevoxTTSSpeaker: `  ${EMOJI}  `,
      assistantLabel: EMOJI, bymPreset: DECOMPOSED, live2dModel: EMOJI.repeat(4),
      blockWords: [DECOMPOSED, DECOMPOSED.normalize('NFC'), ` ${DECOMPOSED} `, EMOJI],
      promptBlockWords: EMOJI, bymDisableGroup: [EMOJI, EMOJI, '', '  '],
      bymFuckList: [`${EMOJI}${EMOJI}`], ttsMode: 'voicevox', bymThinkingMode: 'disabled',
      bymReasoningEffort: 'ultra', apiKey: '🙂', openAiBaseUrl: EMOJI, model: EMOJI
    })
  })

type Args = readonly unknown[]

export const SCALAR_CASES: ReadonlyMap<string, readonly Args[]> = new Map<string, readonly Args[]>([
  ['normalizedText', Object.freeze([
    [undefined, 16], [null, 16], [42, 16], [true, 16], [[], 16], [{}, 16],
    ['', 16], ['   ', 16], ['　', 16], ['  abc  ', 16],
    [undefined, 16, '兜底'], ['', 16, '兜底'], ['  ', 16, '兜底'], ['值', 16, '兜底'],
    ['x', 0], ['abc', 1], ['abc', 2], ['abc', -1], ['abc', Number.NaN],
    [DECOMPOSED, 3], [DECOMPOSED.normalize('NFC'), 3], [EMOJI, 1], [EMOJI, 2],
    ['a'.repeat(100), 8], ['纳西妲', 256], [' 纳西妲 ', 2]
  ])],
  ['normalizedStringList', Object.freeze([
    [undefined], [null], [42], [{}], [true], [''], ['单个'], ['  单个  '],
    [['a', 'a', ' a ', 'b']], [['a', 1, null, 'b']], [[]],
    [[DECOMPOSED, DECOMPOSED.normalize('NFC')]],
    [Array.from({ length: 5 }, (_, index) => `x${index}`), 3],
    [['abcdef'], 8, 3], [[EMOJI], 8, 1], [[''], 8, 8], [['a'], 0, 8]
  ])],
  ['finiteInteger', Object.freeze([
    [undefined, 7, 1, 10], [null, 7, 1, 10], ['5', 7, 1, 10], [true, 7, 1, 10],
    [Number.NaN, 7, 1, 10], [Number.POSITIVE_INFINITY, 7, 1, 10],
    [Number.NEGATIVE_INFINITY, 7, 1, 10],
    [0, 7, 1, 10], [1, 7, 1, 10], [10, 7, 1, 10], [11, 7, 1, 10],
    [5.9, 7, 1, 10], [-5.9, 7, -10, 10], [-0.4, 7, 0, 10], [-0, 7, -10, 10],
    [1e21, 7, 1, 10]
  ])],
  ['finiteNumber', Object.freeze([
    [undefined, 1, 0.5, 4], [null, 1, 0.5, 4], ['2', 1, 0.5, 4], [Number.NaN, 1, 0.5, 4],
    [Number.POSITIVE_INFINITY, 1, 0.5, 4], [Number.NEGATIVE_INFINITY, 1, 0.5, 4],
    [0.5, 1, 0.5, 4], [0.49, 1, 0.5, 4], [4, 1, 0.5, 4], [4.01, 1, 0.5, 4],
    [2.5, 1, 0.5, 4], [-0, 1, -1, 1], [-0.0001, 1, 0, 1]
  ])],
  ['configuredThinkingMode', Object.freeze([
    ['enabled'], ['disabled'], ['default'], ['Enabled'], [undefined], [null], [0], ['']
  ])],
  ['configuredReasoningEffort', Object.freeze([
    ['low'], ['medium'], ['high'], ['xhigh'], ['max'], ['ultra'], ['default'], ['LOW'],
    [undefined], [7]
  ])],
  ['parsePreferenceRecord', Object.freeze([
    [undefined], [null], [42], [''], ['not json'], ['[]'], ['null'], ['"text"'], ['{}'],
    ['{"usePicture":true}'], ['{"a":{"b":1}}'], ['{"usePicture":true,'], ['true']
  ])]
])

const PREFERENCE_RECORDS: readonly unknown[] = Object.freeze([
  {}, { usePicture: true, useTTS: false }, { usePicture: 'true', useTTS: 1 },
  { ttsRole: '  钟离  ', ttsRoleAzure: '', ttsRoleVoiceVox: 7 },
  { ttsRole: DECOMPOSED }, { usePicture: false, useTTS: true, ttsRole: EMOJI }
])

const PROJECTION_FUNCTIONS: readonly string[] = Object.freeze([
  'ttsMode', 'currentPresentationConfig', 'defaultPreferences',
  'buttonPolicy.snapshot', 'bymPolicy.snapshot'
])

export interface BaselineRow {
  readonly fn: string
  readonly config: string | null
  readonly args: readonly Encoded[]
  readonly result: Encoded
  readonly frozen: boolean | null
}

function text (value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function legacyCallers (
  api: LegacyHostApi
): Readonly<Record<string, (args: Args) => unknown>> {
  return Object.freeze({
    normalizedText: args => api.normalizedText(args[0], Number(args[1]), text(args[2])),
    normalizedStringList: args => api.normalizedStringList(
      args[0],
      args[1] === undefined ? undefined : Number(args[1]),
      args[2] === undefined ? undefined : Number(args[2])
    ),
    finiteInteger: args => api.finiteInteger(
      args[0], Number(args[1]), Number(args[2]), Number(args[3])
    ),
    finiteNumber: args => api.finiteNumber(
      args[0], Number(args[1]), Number(args[2]), Number(args[3])
    ),
    configuredThinkingMode: args => api.configuredThinkingMode(args[0]),
    configuredReasoningEffort: args => api.configuredReasoningEffort(args[0]),
    parsePreferenceRecord: args => api.parsePreferenceRecord(args[0]),
    ttsMode: () => api.ttsMode(),
    currentPresentationConfig: () => api.currentPresentationConfig(),
    defaultPreferences: () => api.defaultPreferences(),
    projectPreferences: args => api.projectPreferences(
      (args[0] ?? {}) as Readonly<Record<string, unknown>>
    ),
    'buttonPolicy.snapshot': () => api.buttonPolicy.snapshot(),
    'bymPolicy.snapshot': () => api.bymPolicy.snapshot()
  })
}

function row (api: LegacyHostApi, fn: string, config: string | null, args: Args): BaselineRow {
  const call = legacyCallers(api)[fn]
  if (call === undefined) throw new Error(`no legacy caller for ${fn}`)
  const result = call(args)
  return Object.freeze({
    fn,
    config,
    args: Object.freeze(args.map(encodeValue)),
    result: encodeValue(result),
    frozen: result !== null && typeof result === 'object' ? Object.isFrozen(result) : null
  })
}

export function buildRows (source: string): readonly BaselineRow[] {
  const rows: BaselineRow[] = []
  const scalar = legacyHostApi(source, CONFIG_FIXTURES.empty)
  for (const [fn, cases] of SCALAR_CASES) {
    for (const args of cases) rows.push(row(scalar, fn, null, args))
  }
  for (const [name, config] of Object.entries(CONFIG_FIXTURES)) {
    const api = legacyHostApi(source, config)
    for (const fn of PROJECTION_FUNCTIONS) rows.push(row(api, fn, name, []))
    for (const preference of PREFERENCE_RECORDS) {
      rows.push(row(api, 'projectPreferences', name, [preference]))
    }
  }
  return Object.freeze(rows)
}

export interface BaselineFixture {
  readonly schemaVersion: 1
  readonly baselineCommit: string
  readonly baselineSha256: string
  readonly generator: string
  readonly sectionName: 'configFixtures'
  readonly section: Readonly<Record<string, Encoded>>
  readonly rows: readonly BaselineRow[]
}

export function captureBaseline (source: string): BaselineFixture {
  const configFixtures: Record<string, Encoded> = {}
  for (const [name, config] of Object.entries(CONFIG_FIXTURES)) {
    configFixtures[name] = encodeValue(config)
  }
  return Object.freeze({
    schemaVersion: 1,
    baselineCommit: BASELINE_COMMIT,
    baselineSha256: sourceSha256(source),
    generator: 'src/verification/host-bootstrap-baseline.ts',
    sectionName: 'configFixtures',
    section: Object.freeze(configFixtures),
    rows: buildRows(source)
  })
}

export function main (): void {
  writeFixture(FIXTURE_PATH, captureBaseline(legacyIndexSource(BASELINE_COMMIT)))
}
