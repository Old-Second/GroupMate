import { createHash } from 'node:crypto'
import {
  ModelProviderError,
  type ModelAdapter,
  type ModelRequest,
  type ModelTurn
} from '../agent/model/model-adapter.js'

export const translateLangSupports = Object.freeze([
  Object.freeze({ code: 'ar', label: '阿拉伯语', abbr: '阿', alphabet: 'A' }),
  Object.freeze({ code: 'de', label: '德语', abbr: '德', alphabet: 'D' }),
  Object.freeze({ code: 'ru', label: '俄语', abbr: '俄', alphabet: 'E' }),
  Object.freeze({ code: 'fr', label: '法语', abbr: '法', alphabet: 'F' }),
  Object.freeze({ code: 'ko', label: '韩语', abbr: '韩', alphabet: 'H' }),
  Object.freeze({ code: 'nl', label: '荷兰语', abbr: '荷', alphabet: 'H' }),
  Object.freeze({ code: 'pt', label: '葡萄牙语', abbr: '葡', alphabet: 'P' }),
  Object.freeze({ code: 'ja', label: '日语', abbr: '日', alphabet: 'R' }),
  Object.freeze({ code: 'th', label: '泰语', abbr: '泰', alphabet: 'T' }),
  Object.freeze({ code: 'es', label: '西班牙语', abbr: '西', alphabet: 'X' }),
  Object.freeze({ code: 'en', label: '英语', abbr: '英', alphabet: 'Y' }),
  Object.freeze({ code: 'it', label: '意大利语', abbr: '意', alphabet: 'Y' }),
  Object.freeze({ code: 'vi', label: '越南语', abbr: '越', alphabet: 'Y' }),
  Object.freeze({ code: 'id', label: '印度尼西亚语', abbr: '印', alphabet: 'Y' }),
  Object.freeze({ code: 'zh-CHS', label: '中文', abbr: '中', alphabet: 'Z' })
])

const INVALID_LANGUAGE = `未找到翻译的语种，支持的语言为：\n${
  translateLangSupports.map(item => item.abbr).join('，')
}\n`
const LEGACY_RESULT_ERROR = '找不到翻译结果'
const LEGACY_API_ERROR = '翻译服务暂不可用，请稍后再试'
const MODEL_FALLBACK_EVENT = 'groupmate.translation.model_fallback'
const MAX_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 64 * 1_024

export interface TranslationModelOptions {
  readonly model: string | (() => string)
  readonly adapter: Pick<ModelAdapter, 'complete'>
  readonly timeoutMs?: number | (() => number)
  readonly temperature?: number | (() => number)
}

export interface TranslationFetchResponse {
  readonly ok: boolean
  readonly headers: { get(name: string): string | null }
  readonly body: AsyncIterable<unknown>
}

export type TranslationFetch = (
  url: string,
  init?: RequestInit
) => Promise<TranslationFetchResponse>

export interface TranslationServiceOptions {
  readonly model?: TranslationModelOptions
  readonly fetch?: TranslationFetch
  readonly logger?: Readonly<{ info(event: string): void }>
  readonly now?: () => number
  readonly random?: () => number
}

export interface TranslationService {
  translate(message: string, to?: string, from?: string, signal?: AbortSignal): Promise<string>
  translate(
    message: readonly string[],
    to?: string,
    from?: string,
    signal?: AbortSignal
  ): Promise<readonly string[]>
  translateOld(message: string, to?: string, signal?: AbortSignal): Promise<string>
  translateOld(message: readonly string[], to?: string, signal?: AbortSignal): Promise<readonly string[]>
}

type DynamicNumber = number | (() => number) | undefined

function currentNumber (value: DynamicNumber): number | undefined {
  return typeof value === 'function' ? value() : value
}

function boundedTimeout (configured: DynamicNumber): number {
  const value = currentNumber(configured)
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), MAX_TIMEOUT_MS)
    : MAX_TIMEOUT_MS
}

function boundedTemperature (configured: DynamicNumber): number | undefined {
  const value = currentNumber(configured)
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2
    ? value
    : undefined
}

function languageCode (value: string, allowAuto: boolean): string | null {
  if (allowAuto && value === 'auto') return 'auto'
  return translateLangSupports.find(item => item.abbr === value || item.code === value)?.code ?? null
}

function translationRequest (
  text: string,
  to: string,
  from: string,
  model: TranslationModelOptions,
  modelName: string
): ModelRequest {
  const temperature = boundedTemperature(model.temperature)
  return Object.freeze({
    model: modelName,
    messages: Object.freeze([
      Object.freeze({
        role: 'system' as const,
        content: `You will be provided with a sentence in the language with language code [${from}], and your task is to translate it into [${to}]. Just print the result without any other words.`
      }),
      Object.freeze({ role: 'user' as const, content: text })
    ]),
    tools: Object.freeze([]),
    toolMode: 'disabled',
    streaming: false,
    maxOutputTokens: 2_048,
    reasoning: Object.freeze({ enabled: false }),
    ...(temperature === undefined ? {} : { temperature })
  })
}

function currentModel (configured: TranslationModelOptions['model']): string {
  const model = typeof configured === 'function' ? configured() : configured
  if (typeof model !== 'string' || model.length > 256) {
    throw new TypeError('translation model configuration is invalid')
  }
  return model
}

function completedTranslation (turn: ModelTurn): string {
  const text = turn.text.normalize('NFC').trim()
  if (turn.refusal !== undefined || turn.toolCalls.length > 0 ||
    turn.finishReason !== 'stop' || text === '' ||
    Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) {
    throw new TypeError('translation model response is invalid')
  }
  return text
}

async function modelTranslation (
  text: string,
  to: string,
  from: string,
  model: TranslationModelOptions,
  signal?: AbortSignal
): Promise<string> {
  const modelName = currentModel(model.model)
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort(signal?.reason)
  if (signal?.aborted === true) forwardAbort()
  else signal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new DOMException('translation timed out', 'TimeoutError'))
  }, boundedTimeout(model.timeoutMs))
  timer.unref?.()
  try {
    return completedTranslation(await model.adapter.complete(
      translationRequest(text, to, from, model, modelName),
      controller.signal
    ))
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
  }
}

function formBody (values: Readonly<Record<string, string>>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&')
}

function legacyTargets (value: unknown, output: string[] = []): readonly string[] {
  if (Array.isArray(value)) {
    for (const item of value) legacyTargets(item, output)
    return output
  }
  if (value !== null && typeof value === 'object') {
    const target = (value as { readonly tgt?: unknown }).tgt
    if (typeof target === 'string' && target !== '') output.push(target)
  }
  return output
}

async function defaultFetch (url: string, init?: RequestInit): Promise<TranslationFetchResponse> {
  return await fetch(url, init) as unknown as TranslationFetchResponse
}

function abortReason (signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('translation request aborted', 'AbortError')
}

async function nextResponseChunk (
  iterator: AsyncIterator<unknown>,
  signal: AbortSignal
): Promise<IteratorResult<unknown>> {
  if (signal.aborted) throw abortReason(signal)
  return await new Promise<IteratorResult<unknown>>((resolve, reject) => {
    let settled = false
    const settle = (): boolean => {
      if (settled) return false
      settled = true
      signal.removeEventListener('abort', onAbort)
      return true
    }
    const onAbort = (): void => {
      if (settle()) reject(abortReason(signal))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    let next: PromiseLike<IteratorResult<unknown>>
    try {
      next = Promise.resolve(iterator.next())
    } catch (error) {
      if (settle()) reject(error)
      return
    }
    next.then(
      value => {
        if (settle()) resolve(value)
      },
      error => {
        if (settle()) reject(error)
      }
    )
  })
}

function closeResponseIterator (
  body: AsyncIterable<unknown>,
  iterator: AsyncIterator<unknown>
): void {
  if (typeof iterator.return === 'function') {
    try {
      void Promise.resolve(iterator.return()).catch(() => undefined)
    } catch {}
    return
  }
  const cancellable = body as unknown as {
    destroy?: () => void
    cancel?: () => Promise<unknown>
  }
  try {
    if (typeof cancellable.destroy === 'function') cancellable.destroy()
    else if (typeof cancellable.cancel === 'function') {
      void Promise.resolve(cancellable.cancel()).catch(() => undefined)
    }
  } catch {}
}

async function boundedJson (
  response: TranslationFetchResponse,
  signal: AbortSignal
): Promise<unknown> {
  const header = response.headers.get('content-length')
  if (header !== null) {
    const normalized = header.trim()
    if (!/^(?:0|[1-9][0-9]*)$/.test(normalized) ||
      Number(normalized) > 256 * 1024) throw new Error('translation response is too large')
  }
  if (response.body === null || typeof response.body !== 'object' ||
    response.body[Symbol.asyncIterator] === undefined) {
    throw new Error('translation response body is unavailable')
  }
  const iterator = response.body[Symbol.asyncIterator]()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  let completed = false
  try {
    while (true) {
      const result = await nextResponseChunk(iterator, signal)
      if (result.done === true) {
        completed = true
        break
      }
      const chunk = result.value
      const bytes = typeof chunk === 'string'
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array ? chunk : null
      if (bytes === null) throw new Error('translation response chunk is invalid')
      byteLength += bytes.byteLength
      if (byteLength > 256 * 1024) throw new Error('translation response is too large')
      chunks.push(bytes)
    }
  } catch (error) {
    if (!completed) closeResponseIterator(response.body, iterator)
    throw error
  }
  if (byteLength === 0) throw new Error('translation response is empty')
  return JSON.parse(Buffer.concat(chunks, byteLength).toString('utf8'))
}

function requestBoundary (configuredTimeout: DynamicNumber, signal?: AbortSignal): {
  readonly signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const forwardAbort = (): void => controller.abort(signal?.reason)
  if (signal?.aborted === true) forwardAbort()
  else signal?.addEventListener('abort', forwardAbort, { once: true })
  const timer = setTimeout(() => {
    controller.abort(new DOMException('translation request timed out', 'TimeoutError'))
  }, boundedTimeout(configuredTimeout))
  timer.unref?.()
  return Object.freeze({
    signal: controller.signal,
    dispose (): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }
  })
}

export function createTranslationService (
  options: TranslationServiceOptions = Object.freeze({})
): TranslationService {
  if (options.model !== undefined &&
    ((typeof options.model.model !== 'string' && typeof options.model.model !== 'function') ||
      (typeof options.model.model === 'string' && options.model.model.length > 256) ||
      typeof options.model.adapter?.complete !== 'function')) {
    throw new TypeError('translation model configuration is invalid')
  }
  const fetchPort = options.fetch ?? defaultFetch
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random

  async function translateOldOne (
    message: string,
    to = 'auto',
    signal?: AbortSignal
  ): Promise<string> {
    const target = languageCode(to, true)
    if (target === null) return INVALID_LANGUAGE
    const timestamp = String(Math.trunc(now()))
    const sample = random()
    const suffix = Number.isFinite(sample)
      ? Math.min(Math.max(Math.trunc(sample * 10), 0), 9)
      : 0
    const salt = `${timestamp}${suffix}`
    const client = 'fanyideskweb'
    const sign = createHash('md5')
      .update(`${client}${message}${salt}Ygy_4c=r#e#4EX^NUGUc5`)
      .digest('hex')
    const body = formBody({
      i: message,
      lts: timestamp,
      sign,
      salt,
      from: 'auto',
      to: target,
      bv: createHash('md5')
        .update('5.0 (Windows NT 10.0; Win64; x64) Chrome/98.0.4750.0')
        .digest('hex'),
      client,
      doctype: 'json',
      version: '2.1',
      keyfrom: 'fanyi.web',
      action: 'FY_BY_DEFAULT',
      smartresult: 'dict'
    })
    const boundary = requestBoundary(options.model?.timeoutMs, signal)
    try {
      const response = await fetchPort(
        'https://fanyi.youdao.com/translate_o?smartresult=dict&smartresult=rule',
        {
          method: 'POST',
          body,
          signal: boundary.signal,
          headers: Object.freeze({
            Host: 'fanyi.youdao.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/98.0.4758.102',
            Referer: 'https://fanyi.youdao.com/',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
          })
        }
      )
      if (!response.ok) return LEGACY_API_ERROR
      const payload = await boundedJson(response, boundary.signal)
      if (payload === null || typeof payload !== 'object' ||
        (payload as { readonly errorCode?: unknown }).errorCode !== 0) {
        return LEGACY_API_ERROR
      }
      const targets = legacyTargets(
        (payload as { readonly translateResult?: unknown }).translateResult
      )
      return targets.length === 0 ? LEGACY_RESULT_ERROR : targets.join('\n')
    } catch {
      if (signal?.aborted === true) throw signal.reason
      return LEGACY_API_ERROR
    } finally {
      boundary.dispose()
    }
  }

  async function translateOldValue (
    message: string | readonly string[],
    to = 'auto',
    signal?: AbortSignal
  ): Promise<string | readonly string[]> {
    if (Array.isArray(message)) {
      const results: string[] = []
      for (const item of message) results.push(await translateOldOne(item, to, signal))
      return Object.freeze(results)
    }
    return await translateOldOne(message as string, to, signal)
  }

  async function translateOne (
    message: string,
    to = 'auto',
    from = 'auto',
    signal?: AbortSignal
  ): Promise<string> {
    const target = to === 'auto' ? 'zh-CHS' : languageCode(to, false)
    if (target === null) return INVALID_LANGUAGE
    if (options.model !== undefined && currentModel(options.model.model).trim() !== '') {
      try {
        return await modelTranslation(message, target, from, options.model, signal)
      } catch (error) {
        if (signal?.aborted === true) throw signal.reason
        if (error instanceof ModelProviderError && error.stage === 'model.configuration') {
          throw error
        }
        try {
          options.logger?.info(MODEL_FALLBACK_EVENT)
        } catch {}
      }
    }
    return await translateOldOne(message, to, signal)
  }

  async function translateValue (
    message: string | readonly string[],
    to = 'auto',
    from = 'auto',
    signal?: AbortSignal
  ): Promise<string | readonly string[]> {
    if (Array.isArray(message)) {
      const results: string[] = []
      for (const item of message) results.push(await translateOne(item, to, from, signal))
      return Object.freeze(results)
    }
    return await translateOne(message as string, to, from, signal)
  }

  return Object.freeze({
    translate: translateValue as TranslationService['translate'],
    translateOld: translateOldValue as TranslationService['translateOld']
  })
}

let activeService = createTranslationService()
let productionConfigured = false

export function configureTranslationService (
  options: TranslationServiceOptions
): TranslationService {
  if (productionConfigured) throw new Error('translation service is already configured')
  activeService = createTranslationService(options)
  productionConfigured = true
  return activeService
}

export async function translate (
  message: string,
  to?: string,
  from?: string,
  signal?: AbortSignal
): Promise<string>
export async function translate (
  message: readonly string[],
  to?: string,
  from?: string,
  signal?: AbortSignal
): Promise<readonly string[]>
export async function translate (
  message: string | readonly string[],
  to = 'auto',
  from = 'auto',
  signal?: AbortSignal
): Promise<string | readonly string[]> {
  return Array.isArray(message)
    ? await activeService.translate(message, to, from, signal)
    : await activeService.translate(message as string, to, from, signal)
}

export async function translateOld (
  message: string,
  to?: string,
  signal?: AbortSignal
): Promise<string>
export async function translateOld (
  message: readonly string[],
  to?: string,
  signal?: AbortSignal
): Promise<readonly string[]>
export async function translateOld (
  message: string | readonly string[],
  to = 'auto',
  signal?: AbortSignal
): Promise<string | readonly string[]> {
  return Array.isArray(message)
    ? await activeService.translateOld(message, to, signal)
    : await activeService.translateOld(message as string, to, signal)
}
