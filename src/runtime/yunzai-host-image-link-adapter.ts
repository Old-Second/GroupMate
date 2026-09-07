/**
 * Host adapter for signed image links.
 *
 * The current scene keys come from the host's own OneBot implementation
 * (`get_rkey`), which is a non-standard action, so the call stays behind this
 * adapter and every failure degrades to "no key available". Liveness is checked
 * with a ranged read of the first byte, which is the cheapest way to tell a
 * rotated key apart from a file the host has dropped.
 */

import {
  type HostImageLinkKeys,
  normalizeHostImageLinkKey,
  parseHostImageLink
} from './host-image-link.js'
import type {
  HostImageLinkKeySource,
  HostImageLinkLiveness,
  HostImageLinkProbe
} from './host-image-link-service.js'
import { listYunzaiBots } from './yunzai-bot-registry.js'

type YunzaiRecord = Record<string, any>

const KEY_REQUEST_TIMEOUT_MS = 1_500
const KEY_FAILURE_BACKOFF_MS = 5 * 60 * 1_000
const MAX_KEY_LIFETIME_MS = 60 * 60 * 1_000
const MAX_KEY_REUSE_MS = 10 * 60 * 1_000
const KEY_EXPIRY_MARGIN_MS = 60 * 1_000
const PROBE_TIMEOUT_MS = 1_500
// NapCat exposes the scene keys under the standard name and an own-namespace
// alias, depending on the build.
const KEY_ACTIONS = Object.freeze(['get_rkey', 'nc_get_rkey'])

function botIdOf (bot: YunzaiRecord): string | null {
  for (const key of ['uin', 'self_id', 'id']) {
    try {
      const value = Reflect.get(bot, key)
      if (typeof value === 'string' && /^\d{1,32}$/.test(value)) return value
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
        return String(value)
      }
    } catch {
      continue
    }
  }
  return null
}

function selectBot (botId: string | null): YunzaiRecord | null {
  const bots = listYunzaiBots().filter(bot => {
    try {
      return typeof Reflect.get(bot, 'sendApi') === 'function'
    } catch {
      return false
    }
  })
  if (bots.length === 0) return null
  if (botId !== null) {
    const matched = bots.find(bot => botIdOf(bot) === botId)
    if (matched !== undefined) return matched
  }
  return bots[0] ?? null
}

function keyEntries (payload: unknown): readonly YunzaiRecord[] {
  let node = payload
  // Host adapters differ in how deeply they wrap an action result.
  for (let depth = 0; depth < 3; depth += 1) {
    if (Array.isArray(node)) return node as readonly YunzaiRecord[]
    if (node === null || typeof node !== 'object') return []
    const record = node as YunzaiRecord
    const rkeys = Reflect.get(record, 'rkeys')
    if (Array.isArray(rkeys)) return rkeys as readonly YunzaiRecord[]
    node = Reflect.get(record, 'data')
  }
  return []
}

function lifetimeMs (value: unknown): number | null {
  const seconds = typeof value === 'string' ? Number(value) : value
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null
  return Math.min(Math.trunc(seconds * 1_000), MAX_KEY_LIFETIME_MS)
}

/**
 * When the host minted a key, when it reports a plausible instant.
 *
 * The reported lifetime is the key's total life, not what is left of it, so the
 * mint instant is what keeps a nearly rotated key from being trusted for its
 * full lifetime.
 */
function mintedAtMs (value: unknown, nowMs: number): number | null {
  const seconds = typeof value === 'string' ? Number(value) : value
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null
  const millis = Math.trunc(seconds * 1_000)
  const drift = millis - nowMs
  return drift > MAX_KEY_LIFETIME_MS || drift < -MAX_KEY_LIFETIME_MS ? null : millis
}

export function parseHostImageLinkKeys (
  payload: unknown,
  nowMs: number
): HostImageLinkKeys | null {
  let group: string | undefined
  let priv: string | undefined
  let lifetime: number | null = null
  let mintedAt: number | null = null
  for (const entry of keyEntries(payload)) {
    if (entry === null || typeof entry !== 'object') continue
    const type = Reflect.get(entry, 'type')
    const key = normalizeHostImageLinkKey(Reflect.get(entry, 'rkey'))
    if (key === undefined) continue
    if (type === 'group' && group === undefined) group = key
    if ((type === 'private' || type === 'c2c') && priv === undefined) priv = key
    lifetime ??= lifetimeMs(Reflect.get(entry, 'ttl'))
    mintedAt ??= mintedAtMs(Reflect.get(entry, 'created_at'), nowMs)
  }
  if (group === undefined && priv === undefined) return null
  const expiresAtMs = Math.min(
    (mintedAt ?? nowMs) + (lifetime ?? MAX_KEY_REUSE_MS),
    nowMs + MAX_KEY_LIFETIME_MS
  )
  return Object.freeze({
    ...(group === undefined ? {} : { group }),
    ...(priv === undefined ? {} : { private: priv }),
    refreshedAtMs: nowMs,
    expiresAtMs
  })
}

/**
 * Bounds a host action that cannot be cancelled.
 *
 * The host's OneBot adapter ignores abort signals and waits a full minute for a
 * reply before it gives up, so the caller has to stop waiting on its own or a
 * silent host would stall the reply it is preparing.
 */
async function boundedHostAction<T> (
  action: Promise<T>,
  timeoutMs: number
): Promise<T> {
  action.catch(() => undefined)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      action,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error('host action timed out')) }, timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface YunzaiHostImageLinkKeySourceOptions {
  readonly now?: () => number
  readonly requestTimeoutMs?: number
  readonly requestKeys?: (
    bot: YunzaiRecord,
    action: string,
    signal: AbortSignal
  ) => Promise<unknown>
}

export class YunzaiHostImageLinkKeySource implements HostImageLinkKeySource {
  readonly #now: () => number
  readonly #requestTimeoutMs: number
  readonly #requestKeys: (
    bot: YunzaiRecord,
    action: string,
    signal: AbortSignal
  ) => Promise<unknown>

  readonly #cache = new Map<string, HostImageLinkKeys>()
  readonly #inflight = new Map<string, Promise<HostImageLinkKeys | null>>()
  readonly #retryAfter = new Map<string, number>()

  constructor (options: YunzaiHostImageLinkKeySourceOptions = {}) {
    this.#now = options.now ?? (() => Date.now())
    this.#requestTimeoutMs = options.requestTimeoutMs ?? KEY_REQUEST_TIMEOUT_MS
    this.#requestKeys = options.requestKeys ?? (async (bot, action, signal) => {
      const sendApi = Reflect.get(bot, 'sendApi')
      if (typeof sendApi !== 'function') return null
      return await Reflect.apply(sendApi, bot, [action, {}, signal])
    })
  }

  async keys (botId: string | null, signal: AbortSignal): Promise<HostImageLinkKeys | null> {
    const scope = botId ?? 'default'
    const cached = this.#cache.get(scope)
    if (cached !== undefined && this.#isReusable(cached)) return cached
    const inflight = this.#inflight.get(scope)
    if (inflight !== undefined) return await inflight
    // A host that cannot answer must not be asked once per message.
    const retryAfter = this.#retryAfter.get(scope)
    if (retryAfter !== undefined && this.#now() < retryAfter) return null
    const request = this.#fetch(scope, botId, signal)
      .finally(() => { this.#inflight.delete(scope) })
    this.#inflight.set(scope, request)
    return await request
  }

  #isReusable (keys: HostImageLinkKeys): boolean {
    const now = this.#now()
    return now < keys.expiresAtMs - KEY_EXPIRY_MARGIN_MS &&
      now - keys.refreshedAtMs < MAX_KEY_REUSE_MS
  }

  async #fetch (
    scope: string,
    botId: string | null,
    signal: AbortSignal
  ): Promise<HostImageLinkKeys | null> {
    const bot = selectBot(botId)
    if (bot === null) return null
    for (const action of KEY_ACTIONS) {
      try {
        const payload = await boundedHostAction(
          this.#requestKeys(bot, action, signal),
          this.#requestTimeoutMs
        )
        const keys = parseHostImageLinkKeys(payload, this.#now())
        if (keys === null) continue
        this.#cache.set(scope, keys)
        this.#retryAfter.delete(scope)
        return keys
      } catch {
        continue
      }
    }
    this.#retryAfter.set(scope, this.#now() + KEY_FAILURE_BACKOFF_MS)
    return null
  }
}

export interface HostImageLinkFetchProbeOptions {
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
}

export class HostImageLinkFetchProbe implements HostImageLinkProbe {
  readonly #fetch: typeof fetch
  readonly #timeoutMs: number

  constructor (options: HostImageLinkFetchProbeOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch
    this.#timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS
  }

  async probe (link: string, signal: AbortSignal): Promise<HostImageLinkLiveness> {
    // Only links this project already replays to the provider may be probed.
    if (parseHostImageLink(link) === null) return 'unknown'
    let response: Response
    try {
      const budget = AbortSignal.timeout(this.#timeoutMs)
      response = await this.#fetch(link, {
        method: 'GET',
        headers: { range: 'bytes=0-0' },
        redirect: 'error',
        signal: AbortSignal.any([signal, budget])
      })
    } catch {
      return 'unknown'
    }
    try {
      await response.body?.cancel()
    } catch {
      // The status is the only signal this probe needs.
    }
    if (response.status === 404 || response.status === 410) return 'gone'
    if (response.status >= 200 && response.status < 300) return 'alive'
    return 'unknown'
  }
}
