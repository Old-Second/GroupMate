import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ONLINE_OPENAI_CODES = new Set([
  'ONLINE_OPENAI_DISABLED',
  'ONLINE_OPENAI_CONFIG_MISSING',
  'ONLINE_OPENAI_REQUEST_FAILED',
  'ONLINE_OPENAI_EMPTY_RESPONSE'
])

const REQUIRED_CONFIG = [
  'GROUPMATE_OPENAI_BASE_URL',
  'GROUPMATE_OPENAI_API_KEY',
  'GROUPMATE_OPENAI_MODEL'
]

let clientConsoleTurn = Promise.resolve()

function createOnlineSmokeError (code, missingVariables) {
  const error = new Error(code)
  error.code = code
  if (missingVariables) error.missingVariables = missingVariables
  return error
}

async function createDefaultClient (options) {
  const { ChatGPTAPI } = await import('../utils/openai/chatgpt-api.js')
  return new ChatGPTAPI(options)
}

async function withSuppressedClientConsole (callback) {
  const previousTurn = clientConsoleTurn
  let releaseTurn
  clientConsoleTurn = new Promise(resolveTurn => {
    releaseTurn = resolveTurn
  })

  await previousTurn
  const methods = ['log', 'error', 'warn', 'info', 'debug']
  const originalMethods = new Map()

  try {
    for (const method of methods) {
      originalMethods.set(method, console[method])
      console[method] = () => {}
    }
    return await callback()
  } finally {
    try {
      for (const [method, original] of originalMethods) console[method] = original
    } finally {
      releaseTurn()
    }
  }
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

  return {
    apiBaseUrl: env.GROUPMATE_OPENAI_BASE_URL,
    apiKey: env.GROUPMATE_OPENAI_API_KEY,
    model: env.GROUPMATE_OPENAI_MODEL
  }
}

export async function runOnlineOpenAISmoke ({
  env = process.env,
  createClient = createDefaultClient,
  write = value => process.stdout.write(`${value}\n`)
} = {}) {
  const config = readOnlineOpenAIConfig(env)
  let responseText

  try {
    responseText = await withSuppressedClientConsole(async () => {
      const client = await createClient({
        apiKey: config.apiKey,
        apiBaseUrl: config.apiBaseUrl,
        debug: false,
        completionParams: {
          model: config.model,
          temperature: 0
        },
        systemMessage: 'Reply briefly.',
        maxModelTokens: 256,
        maxResponseTokens: 32,
        getMessageById: async () => undefined,
        upsertMessage: async () => undefined
      })

      const response = await client.sendMessage('Reply with OK.', {
        stream: false,
        timeoutMs: 20_000
      })
      return response?.text
    })
  } catch {
    throw createOnlineSmokeError('ONLINE_OPENAI_REQUEST_FAILED')
  }

  if (typeof responseText !== 'string' || responseText.trim() === '') {
    throw createOnlineSmokeError('ONLINE_OPENAI_EMPTY_RESPONSE')
  }

  const result = {
    ok: true,
    responseCharacters: responseText.length
  }
  write(JSON.stringify(result))
  return result
}

export function formatOnlineSmokeFailure (error) {
  let code
  try {
    code = error?.code
  } catch {
    code = undefined
  }

  return {
    ok: false,
    code: ONLINE_OPENAI_CODES.has(code) ? code : 'ONLINE_OPENAI_FAILED'
  }
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
