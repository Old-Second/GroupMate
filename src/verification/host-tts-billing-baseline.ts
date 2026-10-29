// Batch 5 of the `index.js` host-bootstrap migration: TTS administration (mode, configuration
// checks, voice selection across the three backends, missing-configuration copy) and the OpenAI
// dashboard billing query.
//
// The legacy declarations are sliced out of a pinned `index.js` and executed for real. The three
// speaker catalogues, the alias resolver and the proxy-aware fetch live outside the typed layer, so
// they arrive as fixture tables and a recording stub: a billing row therefore pins the exact URLs,
// method and header shape the query produced.
import {
  normalizedText
} from '../runtime/host/host-config-values.js'
import { resolveTtsMode } from '../runtime/host/host-config-projection.js'
import type {
  HostAzureVoice,
  HostVoiceVoxVoice
} from '../runtime/host/host-voice-tables.js'
import type { TtsMode } from '../runtime/presentation/presentation-settings.js'
import type {
  OpenAiBillingPort,
  TtsAdministrationPort
} from '../runtime/yunzai-chat-controller.js'
import {
  encodeValue,
  legacyIndexSource,
  sliceBlock,
  sourceSha256,
  writeFixture,
  type Encoded
} from './host-bootstrap-fixture.js'

export const BASELINE_COMMIT = '5bf84e2c05f43c118f28ca0d21480a0474708203'
export const FIXTURE_PATH = 'test/fixtures/host-bootstrap/batch-5-tts-billing.json'

export type Recorder = (entry: Readonly<Record<string, unknown>>) => void

export interface TtsBillingApi {
  ttsAdministration: TtsAdministrationPort
  billing: OpenAiBillingPort
}

export const VITS_SPEAKERS: readonly string[] =
  Object.freeze(['纳西妲', '胡桃', '钟离', '派蒙'])

// `convertSpeaker` resolves nicknames to catalogue names and returns its input unchanged when it
// knows no alias; the fixture keeps one alias so that branch is reachable.
export const VITS_ALIASES: Readonly<Record<string, string>> =
  Object.freeze({ 草神: '纳西妲', 火胡: '胡桃' })

export const AZURE_VOICES: readonly HostAzureVoice[] = Object.freeze([
  Object.freeze({
    code: 'zh-CN-XiaochenNeural', name: '晓辰', gender: '女', languageDetail: '中文（普通话）'
  }),
  Object.freeze({
    code: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: '女', languageDetail: '中文（普通话）',
    emotion: Object.freeze(['general', 'cheerful'])
  }),
  Object.freeze({
    code: 'en-US-JennyNeural', name: 'Jenny', gender: '女', languageDetail: 'English (US)',
    emotion: Object.freeze(['general'])
  })
])

export const VOICEVOX_VOICES: readonly HostVoiceVoxVoice[] = Object.freeze([
  Object.freeze({
    name: '护士机器子T',
    styles: Object.freeze([Object.freeze({ name: 'ノーマル' })])
  }),
  Object.freeze({
    name: '四国めたん',
    styles: Object.freeze([
      Object.freeze({ name: 'ノーマル' }),
      Object.freeze({ name: 'あまあま' })
    ])
  }),
  Object.freeze({ name: '有-连字符', styles: Object.freeze([Object.freeze({ name: '标准' })]) })
])

export const CONFIGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = Object.freeze({
  empty: Object.freeze({}),
  vitsConfigured: Object.freeze({
    ttsMode: 'vits-uma-genshin-honkai', ttsSpace: 'https://fixture.invalid/vits'
  }),
  azureConfigured: Object.freeze({
    ttsMode: 'azure', azureTTSKey: 'k-azure', azureTTSEmotion: true
  }),
  azureNoEmotion: Object.freeze({
    ttsMode: 'azure', azureTTSKey: 'k-azure', azureTTSEmotion: false
  }),
  voicevoxConfigured: Object.freeze({
    ttsMode: 'voicevox', voicevoxSpace: 'https://fixture.invalid/vv'
  }),
  blankSpaces: Object.freeze({ ttsSpace: '   ', azureTTSKey: '  ', voicevoxSpace: '　' }),
  wrongTypes: Object.freeze({ ttsSpace: 7, azureTTSKey: [], voicevoxSpace: null }),
  billingReady: Object.freeze({
    openAiBaseUrl: 'https://fixture.invalid/v1///', apiKey: 'k-b'
  }),
  billingBlankEndpoint: Object.freeze({ openAiBaseUrl: '   ', apiKey: 'k-b' })
})

export const MODES: readonly TtsMode[] =
  Object.freeze(['vits-uma-genshin-honkai', 'azure', 'voicevox'])

export const VOICE_REQUESTS: readonly unknown[] = Object.freeze([
  '随机', '', '   ', undefined, null, 42,
  '纳西妲', '草神', '火胡', '不存在的角色',
  '晓晓', 'Jenny', '晓辰', 'zh-CN-XiaoxiaoNeural',
  '护士机器子T', '四国めたん-あまあま', '四国めたん-不存在', '有-连字符',
  '  晓晓  ', 'ロ'.repeat(600)
])

// `access_until` stays a seven-digit epoch: the fixture-safety gate rejects any 8-to-12 digit run
// as a possible QQ identifier, and the query only cares that the value parses into a valid date.
export const BILLING_RESPONSES: Readonly<Record<string, Encoded>> = Object.freeze({
  healthy: {
    subscription: { ok: true, body: { hard_limit_usd: 120, access_until: 9_999_999 } },
    usage: { ok: true, body: { total_usage: 4_250 } }
  },
  subscriptionRejected: {
    subscription: { ok: false, body: {} },
    usage: { ok: true, body: { total_usage: 1 } }
  },
  usageRejected: {
    subscription: { ok: true, body: { hard_limit_usd: 1, access_until: 9_999_999 } },
    usage: { ok: false, body: {} }
  },
  missingLimit: {
    subscription: { ok: true, body: { access_until: 9_999_999 } },
    usage: { ok: true, body: { total_usage: 1 } }
  },
  missingUsage: {
    subscription: { ok: true, body: { hard_limit_usd: 1, access_until: 9_999_999 } },
    usage: { ok: true, body: {} }
  },
  invalidAccessUntil: {
    subscription: { ok: true, body: { hard_limit_usd: 1, access_until: 'soon' } },
    usage: { ok: true, body: { total_usage: 1 } }
  },
  nonObjectBodies: {
    subscription: { ok: true, body: 'nope' },
    usage: { ok: true, body: 'nope' }
  }
})

// Dates that cross a month and a year boundary once the query adds a day and subtracts 100.
export const NOW_VALUES: readonly string[] = Object.freeze([
  '2026-10-29T12:00:00.000Z', '2026-01-31T23:30:00.000Z', '2026-03-01T00:00:00.000Z'
])

export interface TtsBillingRow {
  readonly fn: string
  readonly config: string
  readonly response: string | null
  readonly args: readonly Encoded[]
  readonly result: Encoded
  readonly calls: readonly Encoded[]
  readonly frozen: boolean | null
}

export function recordingFetch (responseName: string, log: Recorder): (
  url: string, init: Readonly<{ method: string, headers: Readonly<Record<string, string>> }>
) => Promise<{ readonly ok: boolean, json: () => Promise<unknown> }> {
  const plan = BILLING_RESPONSES[responseName] as Readonly<Record<string, {
    readonly ok: boolean
    readonly body: unknown
  }>>
  return async (url, init) => {
    log({ host: 'fetch', url, method: init.method, headers: Object.keys(init.headers) })
    const stage = url.includes('/usage') ? 'usage' : 'subscription'
    const response = plan[stage]
    return { ok: response.ok, json: async () => response.body }
  }
}

export function convertSpeaker (voice: string): string {
  return VITS_ALIASES[voice] ?? voice
}

export async function runCase (
  api: TtsBillingApi,
  config: Record<string, unknown>,
  fn: string,
  args: readonly unknown[]
): Promise<{ readonly result: unknown; readonly frozen: boolean | null }> {
  let result: unknown
  try {
    if (fn === 'getMode') result = api.ttsAdministration.getMode()
    else if (fn === 'isConfigured') result = api.ttsAdministration.isConfigured(args[0] as TtsMode)
    else if (fn === 'missingConfigurationMessage') {
      result = api.ttsAdministration.missingConfigurationMessage(
        args[0] as TtsMode, args[1] as 'enable' | 'role'
      )
    } else if (fn === 'selectVoice') {
      result = api.ttsAdministration.selectVoice(args[0] as TtsMode, args[1] as string)
    } else if (fn === 'setMode') {
      api.ttsAdministration.setMode(args[0] as TtsMode)
      result = Object.freeze({
        storedTtsMode: config.ttsMode, getMode: api.ttsAdministration.getMode()
      })
    } else if (fn === 'queryLastHundredDays') {
      result = await api.billing.queryLastHundredDays(new Date(String(args[0])))
    } else throw new Error(`no caller for ${fn}`)
  } catch (error) {
    result = error
  }
  return Object.freeze({
    result,
    frozen: result !== null && typeof result === 'object' ? Object.isFrozen(result) : null
  })
}

export interface TtsBillingScenario {
  readonly config: string
  readonly response: string
}

export type TtsBillingFactory = (
  config: Record<string, unknown>, scenario: TtsBillingScenario, log: Recorder
) => TtsBillingApi

async function row (
  create: TtsBillingFactory,
  fn: string,
  scenario: TtsBillingScenario,
  args: readonly unknown[]
): Promise<TtsBillingRow> {
  const calls: Encoded[] = []
  const log: Recorder = entry => { calls.push(encodeValue(entry)) }
  const config: Record<string, unknown> = { ...CONFIGS[scenario.config] }
  const api = create(config, scenario, log)
  const { result, frozen } = await runCase(api, config, fn, args)
  return Object.freeze({
    fn,
    config: scenario.config,
    response: fn === 'queryLastHundredDays' ? scenario.response : null,
    args: Object.freeze(args.map(encodeValue)),
    result: encodeValue(result),
    calls: Object.freeze(calls),
    frozen
  })
}

const TTS_CONFIGS: readonly string[] = Object.freeze([
  'empty', 'vitsConfigured', 'azureConfigured', 'azureNoEmotion', 'voicevoxConfigured',
  'blankSpaces', 'wrongTypes'
])

export const FIXTURE_TIMEZONE = 'UTC'

export async function buildRowsWith (
  create: TtsBillingFactory
): Promise<readonly TtsBillingRow[]> {
  // The usage window is built from local-calendar arithmetic (`getDate()` plus one, minus a hundred),
  // so the recorded start and end dates depend on the process timezone. That dependency is real
  // legacy behaviour and is preserved; the capture and the replay both pin UTC so the committed
  // fixture means the same thing on every machine.
  const previousTimezone = process.env.TZ
  process.env.TZ = FIXTURE_TIMEZONE
  try {
    return await buildTtsBillingRows(create)
  } finally {
    if (previousTimezone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimezone
  }
}

async function buildTtsBillingRows (
  create: TtsBillingFactory
): Promise<readonly TtsBillingRow[]> {
  const rows: TtsBillingRow[] = []
  const at = (config: string, response = 'healthy'): TtsBillingScenario =>
    Object.freeze({ config, response })

  for (const config of TTS_CONFIGS) {
    rows.push(await row(create, 'getMode', at(config), []))
    for (const mode of MODES) {
      rows.push(await row(create, 'isConfigured', at(config), [mode]))
    }
  }
  for (const mode of MODES) {
    for (const operation of ['enable', 'role']) {
      rows.push(await row(create, 'missingConfigurationMessage', at('empty'), [mode, operation]))
    }
  }
  // The emotion hint is the only part of voice selection the configuration changes, so the request
  // list is crossed against the two Azure configurations and held fixed elsewhere.
  for (const mode of MODES) {
    const configs = mode === 'azure' ? ['azureConfigured', 'azureNoEmotion'] : ['empty']
    for (const config of configs) {
      for (const requested of VOICE_REQUESTS) {
        rows.push(await row(create, 'selectVoice', at(config), [mode, requested]))
      }
    }
  }
  for (const mode of MODES) {
    rows.push(await row(create, 'setMode', at('vitsConfigured'), [mode]))
  }
  for (const response of Object.keys(BILLING_RESPONSES)) {
    rows.push(await row(
      create, 'queryLastHundredDays', at('billingReady', response), [NOW_VALUES[0]]
    ))
  }
  for (const now of NOW_VALUES) {
    rows.push(await row(create, 'queryLastHundredDays', at('billingReady', 'healthy'), [now]))
    rows.push(await row(
      create, 'queryLastHundredDays', at('billingBlankEndpoint', 'healthy'), [now]
    ))
  }
  return Object.freeze(rows)
}

const LEGACY_FUNCTIONS: readonly string[] =
  Object.freeze(['ttsConfigured', 'missingTtsConfiguration', 'selectVoice', 'formatDateOnly'])

export function legacyTtsBilling (
  source: string, config: Record<string, unknown>, scenario: TtsBillingScenario, log: Recorder
): TtsBillingApi {
  const blocks = [
    ...LEGACY_FUNCTIONS.map(name => sliceBlock(source, `\nfunction ${name} (`, '\n}\n', name)),
    sliceBlock(
      source, '\nconst ttsAdministration = Object.freeze({', '\n})\n', 'ttsAdministration'
    ),
    sliceBlock(source, '\nconst billing = Object.freeze({', '\n})\n', 'billing')
  ]
  const names = [
    'Config', 'normalizedText', 'ttsMode', 'convertSpeaker', 'vitsSpeakers', 'azureVoices',
    'voiceVoxVoices', 'newFetch'
  ]
  const factory = new Function(
    ...names, `${blocks.join('\n')}\nreturn { ttsAdministration, billing }`
  ) as (...values: readonly unknown[]) => TtsBillingApi
  return factory(
    config,
    normalizedText,
    () => resolveTtsMode(config),
    convertSpeaker,
    VITS_SPEAKERS,
    AZURE_VOICES,
    VOICEVOX_VOICES,
    recordingFetch(scenario.response, log)
  )
}

export async function buildRows (source: string): Promise<readonly TtsBillingRow[]> {
  return await buildRowsWith(
    (config, scenario, log) => legacyTtsBilling(source, config, scenario, log)
  )
}

export interface TtsBillingFixture {
  readonly schemaVersion: 1
  readonly baselineCommit: string
  readonly baselineSha256: string
  readonly generator: string
  readonly sectionName: 'scenarios'
  readonly section: Readonly<Record<string, Encoded>>
  readonly rows: readonly TtsBillingRow[]
}

export async function captureBaseline (source: string): Promise<TtsBillingFixture> {
  return Object.freeze({
    schemaVersion: 1 as const,
    baselineCommit: BASELINE_COMMIT,
    baselineSha256: sourceSha256(source),
    generator: 'src/verification/host-tts-billing-baseline.ts',
    sectionName: 'scenarios' as const,
    section: Object.freeze({
      configs: encodeValue(CONFIGS),
      modes: encodeValue(MODES),
      vitsSpeakers: encodeValue(VITS_SPEAKERS),
      vitsAliases: encodeValue(VITS_ALIASES),
      azureVoices: encodeValue(AZURE_VOICES),
      voicevoxVoices: encodeValue(VOICEVOX_VOICES),
      voiceRequests: encodeValue(VOICE_REQUESTS),
      billingResponses: encodeValue(BILLING_RESPONSES),
      nowValues: encodeValue(NOW_VALUES),
      timezone: encodeValue(FIXTURE_TIMEZONE)
    }),
    rows: await buildRows(source)
  })
}

export async function main (): Promise<void> {
  writeFixture(FIXTURE_PATH, await captureBaseline(legacyIndexSource(BASELINE_COMMIT)))
}
