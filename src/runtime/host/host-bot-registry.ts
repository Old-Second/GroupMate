import { normalizedText, type HostConfigSource } from './host-config-values.js'
import type { SessionAddress } from '../../agent/contracts/identity.js'
import type { YunzaiBotLike, YunzaiBotPicker } from '../agent-service-bridge.js'

// The Yunzai host exposes its bots through `globalThis.Bot`, whose shape differs between the
// single-account and TRSS multi-account builds: `uin` is a scalar on one and an array on the other,
// and per-bot entries are indexed by account id. Everything below narrows from `unknown` for that
// reason, and the host object itself arrives as an injected reader so this module never touches a
// global of its own.
export interface HostBotRegistryDependencies {
  readonly config: HostConfigSource
  readonly hostBot: () => unknown
  /** Default export of the Yunzai host's `lib/config/config.js`. */
  readonly loadHostConfig: () => Promise<unknown>
}

export type HostMasterId = string | number

export interface HostBotRegistry {
  rememberBot(botId: string, bot: unknown): void
  configuredBotId(event: unknown): string
  readonly botPicker: YunzaiBotPicker
  masterIds(): Promise<readonly HostMasterId[]>
  eventActorId(event: unknown): string
  eventTarget(event: unknown): SessionAddress
}

// A conversation only needs the bot that is currently answering it, so the table stays small and
// evicts in insertion order; re-remembering an id moves it back to the newest slot.
const REMEMBERED_BOT_LIMIT = 8
const IDENTIFIER_CHARACTERS = 128

function record (value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object'
    ? value as Readonly<Record<string, unknown>>
    : {}
}

export function createHostBotRegistry (
  dependencies: HostBotRegistryDependencies
): HostBotRegistry {
  const rememberedBots = new Map<string, unknown>()

  const rememberBot = (botId: string, bot: unknown): void => {
    if (bot === null || typeof bot !== 'object' || botId === '') return
    rememberedBots.delete(botId)
    rememberedBots.set(botId, bot)
    while (rememberedBots.size > REMEMBERED_BOT_LIMIT) {
      const oldest = rememberedBots.keys().next().value
      if (oldest === undefined) break
      rememberedBots.delete(oldest)
    }
  }

  const configuredBotId = (event: unknown): string => {
    const source = record(event)
    let value = source.self_id ?? record(source.bot).uin
    if (value === undefined || value === null || String(value) === '') {
      const globalBot = record(dependencies.hostBot())
      const candidates: readonly unknown[] = Array.isArray(globalBot.uin)
        ? globalBot.uin
        : [globalBot.uin]
      const configured = dependencies.config.trssBotUin
      // Truthiness, not a presence check: an operator who leaves the TRSS account id blank, at 0 or
      // at NaN must fall through to the host's own account list exactly as before.
      value = Boolean(configured) &&
        candidates.some(item => String(item) === String(configured))
        ? configured
        : candidates.filter(item => item !== undefined && item !== null).at(-1)
    }
    const botId = normalizedText(String(value ?? ''), IDENTIFIER_CHARACTERS)
    if (botId === '') throw new TypeError('Yunzai bot identity is unavailable')
    rememberBot(botId, source.bot)
    return botId
  }

  const botPicker: YunzaiBotPicker = Object.freeze({
    async pick (botId: string): Promise<YunzaiBotLike | null> {
      const known = rememberedBots.get(String(botId))
      if (known !== undefined) return known as YunzaiBotLike
      const globalBot = dependencies.hostBot()
      if (globalBot === null || typeof globalBot !== 'object') return null
      const indexed = (globalBot as Record<string, unknown>)[String(botId)]
      if (indexed !== undefined && indexed !== null) return indexed as YunzaiBotLike
      const uin = (globalBot as Record<string, unknown>).uin
      if (!Array.isArray(uin) && String(uin ?? '') === String(botId)) {
        return globalBot as YunzaiBotLike
      }
      return null
    }
  })

  const masterIds = async (): Promise<readonly HostMasterId[]> => {
    const hostConfig = record(await dependencies.loadHostConfig())
    const value = hostConfig.masterQQ
    return Object.freeze((Array.isArray(value) ? value : [value])
      .filter((item): item is HostMasterId =>
        typeof item === 'string' || typeof item === 'number'))
  }

  const eventActorId = (event: unknown): string => {
    const source = record(event)
    return normalizedText(
      String(record(source.sender).user_id ?? source.user_id ?? ''),
      IDENTIFIER_CHARACTERS
    )
  }

  const eventTarget = (event: unknown): SessionAddress => {
    const botId = configuredBotId(event)
    const actorId = eventActorId(event)
    const source = record(event)
    if (source.isGroup === true) {
      return Object.freeze({
        botId,
        scope: Object.freeze({
          kind: 'group' as const,
          groupId: normalizedText(String(source.group_id ?? ''), IDENTIFIER_CHARACTERS)
        })
      })
    }
    return Object.freeze({
      botId,
      scope: Object.freeze({ kind: 'private' as const, userId: actorId })
    })
  }

  return Object.freeze({
    rememberBot, configuredBotId, botPicker, masterIds, eventActorId, eventTarget
  })
}
