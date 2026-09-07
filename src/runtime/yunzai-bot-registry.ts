/**
 * Enumerates the live Yunzai bot instances of the host process.
 *
 * TRSS-Yunzai keeps every logged-in account id in the `Bot.uin` array and the
 * matching instance in `Bot.bots[id]` (also exposed as `Bot[id]`), while
 * `Bot.adapter` only lists adapter descriptors. Legacy single-account hosts are
 * themselves the bot instance. Callers receive real instances only, so a group
 * lookup such as `bot.gl` or a send through `bot.pickGroup` never runs against
 * an aggregate proxy or an undefined entry.
 */

type YunzaiRecord = Record<string, any>

function hostBot (): YunzaiRecord | null {
  try {
    const host = Reflect.get(globalThis, 'Bot') as YunzaiRecord | undefined
    return host === undefined || host === null ? null : host
  } catch {
    return null
  }
}

function botIdentifier (value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    return null
  }
  const normalized = String(value).trim()
  return /^\d{1,32}$/.test(normalized) ? normalized : null
}

function instanceOf (host: YunzaiRecord, botId: string): YunzaiRecord | null {
  for (const candidate of [
    () => Reflect.get(host, 'bots') as YunzaiRecord | undefined,
    () => host
  ]) {
    try {
      const container = candidate()
      if (container === undefined || container === null) continue
      const instance = Reflect.get(container, botId) as unknown
      if (instance !== undefined && instance !== null && typeof instance === 'object') {
        return instance as YunzaiRecord
      }
    } catch {
      continue
    }
  }
  return null
}

function looksLikeBot (value: YunzaiRecord): boolean {
  try {
    return typeof Reflect.get(value, 'pickGroup') === 'function' ||
      Reflect.get(value, 'gl') !== undefined
  } catch {
    return false
  }
}

export function listYunzaiBots (): readonly YunzaiRecord[] {
  const host = hostBot()
  if (host === null) return Object.freeze([])
  let accountIds: readonly unknown[] | null = null
  try {
    const uin = Reflect.get(host, 'uin')
    if (Array.isArray(uin)) accountIds = uin
  } catch {
    accountIds = null
  }
  // Legacy single-account hosts are the bot instance themselves.
  if (accountIds === null) {
    return looksLikeBot(host) ? Object.freeze([host]) : Object.freeze([])
  }
  const bots: YunzaiRecord[] = []
  const seen = new Set<YunzaiRecord>()
  for (const value of accountIds) {
    const botId = botIdentifier(value)
    if (botId === null) continue
    const instance = instanceOf(host, botId)
    if (instance === null || seen.has(instance)) continue
    seen.add(instance)
    bots.push(instance)
  }
  return Object.freeze(bots)
}

/**
 * Sends a group message through a bot instance.
 *
 * TRSS-Yunzai instances only expose `pickGroup(group_id).sendMsg(message)`,
 * while legacy single-account clients also accept `sendGroupMsg(group_id,
 * message)`. Preferring the picker keeps both host generations working without
 * hitting the aggregate `Bot.sendGroupMsg(bot_id, group_id, message)` signature.
 */
export async function sendYunzaiGroupMessage (
  bot: YunzaiRecord,
  groupId: number | string,
  message: unknown
): Promise<unknown> {
  const pickGroup = Reflect.get(bot, 'pickGroup')
  if (typeof pickGroup === 'function') {
    const group = await Reflect.apply(pickGroup, bot, [groupId])
    if (group !== null && typeof group === 'object') {
      const sendMsg = Reflect.get(group, 'sendMsg')
      if (typeof sendMsg === 'function') {
        return await Reflect.apply(sendMsg, group, [message])
      }
    }
  }
  const sendGroupMsg = Reflect.get(bot, 'sendGroupMsg')
  if (typeof sendGroupMsg === 'function') {
    return await Reflect.apply(sendGroupMsg, bot, [groupId, message])
  }
  throw new TypeError('host bot cannot send group messages')
}
