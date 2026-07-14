import { performance } from 'node:perf_hooks'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ONLINE_OPENAI_CODES = new Set([
  'ONLINE_OPENAI_DISABLED',
  'ONLINE_OPENAI_CONFIG_MISSING',
  'ONLINE_OPENAI_PROFILE_INVALID',
  'ONLINE_OPENAI_REQUEST_FAILED',
  'ONLINE_OPENAI_EMPTY_RESPONSE'
])

const REQUIRED_CONFIG = [
  'GROUPMATE_OPENAI_BASE_URL',
  'GROUPMATE_OPENAI_API_KEY',
  'GROUPMATE_OPENAI_MODEL'
]

function createOnlineSmokeError (code, missingVariables, metadata) {
  const error = new Error(code)
  error.code = code
  if (missingVariables) error.missingVariables = missingVariables
  if (metadata) {
    error.selectedProfile = metadata.selectedProfile
    error.selectionSource = metadata.selectionSource
    error.latencyMs = metadata.latencyMs
  }
  return error
}

async function createDefaultFacade (options) {
  const { createOpenAICompatibleCompletionFacade } = await import(
    '../dist/runtime/completion-facade.js'
  )
  return createOpenAICompatibleCompletionFacade(options)
}

export function readOnlineOpenAIConfig (env) {
  if (env.GROUPMATE_RUN_ONLINE_OPENAI !== '1') {
    throw createOnlineSmokeError('ONLINE_OPENAI_DISABLED')
  }

  const missingVariables = REQUIRED_CONFIG.filter(name => {
    const value = env[name]
    return typeof value !== 'string' || value.trim() === ''
  })
  if (missingVariables.length > 0) {
    throw createOnlineSmokeError('ONLINE_OPENAI_CONFIG_MISSING', missingVariables)
  }

  const configuredProfile = env.GROUPMATE_OPENAI_PROFILE
  if (configuredProfile !== undefined && configuredProfile !== 'standard' &&
    configuredProfile !== 'deepseek') {
    throw createOnlineSmokeError('ONLINE_OPENAI_PROFILE_INVALID')
  }
  return Object.freeze({
    endpoint: env.GROUPMATE_OPENAI_BASE_URL,
    apiKey: env.GROUPMATE_OPENAI_API_KEY,
    model: env.GROUPMATE_OPENAI_MODEL,
    profile: configuredProfile ?? 'standard',
    selectionSource: configuredProfile === undefined ? 'default' : 'explicit'
  })
}

function elapsedMilliseconds (startedAt, now) {
  const elapsed = Math.round(now() - startedAt)
  return Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : 0
}

export async function runOnlineOpenAISmoke ({
  env = process.env,
  createFacade = createDefaultFacade,
  write = value => process.stdout.write(`${value}\n`),
  now = () => performance.now()
} = {}) {
  const startedAt = now()
  const config = readOnlineOpenAIConfig(env)
  let responseText

  try {
    const facade = await createFacade({
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      model: config.model,
      openAiCompatibilityProfile: config.profile,
      timeoutMs: 20_000,
      temperature: 0
    })
    responseText = await facade.completeText({
      purpose: 'smoke',
      messages: [
        { role: 'system', content: 'Reply briefly.' },
        { role: 'user', content: 'Reply with OK.' }
      ],
      maxOutputTokens: 32
    }, new AbortController().signal)
  } catch {
    throw createOnlineSmokeError('ONLINE_OPENAI_REQUEST_FAILED', undefined, {
      selectedProfile: config.profile,
      selectionSource: config.selectionSource,
      latencyMs: elapsedMilliseconds(startedAt, now)
    })
  }

  if (typeof responseText !== 'string' || responseText.trim() === '') {
    throw createOnlineSmokeError('ONLINE_OPENAI_EMPTY_RESPONSE', undefined, {
      selectedProfile: config.profile,
      selectionSource: config.selectionSource,
      latencyMs: elapsedMilliseconds(startedAt, now)
    })
  }
  const result = Object.freeze({
    ok: true,
    selectedProfile: config.profile,
    selectionSource: config.selectionSource,
    status: 'completed',
    errorCode: null,
    latencyMs: elapsedMilliseconds(startedAt, now),
    responseCharacters: [...responseText].length
  })
  write(JSON.stringify(result))
  return result
}

function ownValue (error, key) {
  try {
    if ((typeof error !== 'object' || error === null) && typeof error !== 'function') {
      return undefined
    }
    const descriptor = Object.getOwnPropertyDescriptor(error, key)
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

export function formatOnlineSmokeFailure (error) {
  const code = ownValue(error, 'code')
  const selectedProfile = ownValue(error, 'selectedProfile')
  const selectionSource = ownValue(error, 'selectionSource')
  const latencyMs = ownValue(error, 'latencyMs')
  return Object.freeze({
    ok: false,
    selectedProfile: selectedProfile === 'standard' || selectedProfile === 'deepseek'
      ? selectedProfile
      : 'unknown',
    selectionSource: selectionSource === 'default' || selectionSource === 'explicit'
      ? selectionSource
      : 'unknown',
    status: 'failed',
    errorCode: ONLINE_OPENAI_CODES.has(code) ? code : 'ONLINE_OPENAI_FAILED',
    latencyMs: Number.isSafeInteger(latencyMs) && latencyMs >= 0 ? latencyMs : 0,
    responseCharacters: 0
  })
}

function readProcessEntryPoint () {
  if (!process.argv[1]) {
    return { isProcessEntryPoint: false, resolutionFailed: false }
  }
  try {
    return {
      isProcessEntryPoint: realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url)),
      resolutionFailed: false
    }
  } catch {
    return { isProcessEntryPoint: false, resolutionFailed: true }
  }
}

const processEntryPoint = readProcessEntryPoint()

if (processEntryPoint.resolutionFailed) {
  process.stdout.write(`${JSON.stringify(formatOnlineSmokeFailure())}\n`)
  process.exitCode = 1
} else if (processEntryPoint.isProcessEntryPoint) {
  runOnlineOpenAISmoke().catch(error => {
    process.stdout.write(`${JSON.stringify(formatOnlineSmokeFailure(error))}\n`)
    process.exitCode = 1
  })
}
