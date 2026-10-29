/**
 * Daily and hourly quota for the host cron greeting path.
 *
 * `apps/entertainment.js` registers a Yunzai task that fires every
 * `helloInterval` hours and, once `helloProbability` passes, calls the
 * auxiliary completion service once per (bot, group). That call carries no
 * RunBudget, no admission accounting and no checkpoint, so until this module
 * the only bound on it was the concurrency claim in `ProactiveCoordination` —
 * a de-duplication mechanism, not a budget.
 *
 * The counters live in Redis rather than in memory because a deploy restart
 * must not hand the cron a fresh daily allowance. Windows slide instead of
 * snapping to a calendar day: the cron only runs between 07:00 and 23:00 local
 * time, so a UTC day boundary would fall in the middle of its window.
 *
 * Every rejection means no model call and no send. Store failures reject as
 * well: losing one optional greeting costs nothing, while an unbounded number
 * of provider calls does.
 */

export type GreetingQuotaRejection =
  | 'identity'
  | 'daily_group'
  | 'hourly_global'
  | 'scope_pressure'
  | 'store_unavailable'
  | 'conflict'

export interface GreetingQuotaUsage {
  readonly dailyUsed: number
  readonly dailyLimit: number
  readonly hourlyUsed: number
  readonly hourlyLimit: number
}

export type GreetingQuotaDecision =
  | Readonly<{ kind: 'allowed' } & GreetingQuotaUsage>
  | Readonly<{ kind: 'rejected'; reason: GreetingQuotaRejection } & GreetingQuotaUsage>

export interface GreetingQuotaRedisClient {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}

export const GREETING_QUOTA_KEY = 'GROUPMATE:GREETING:QUOTA:v1'
export const GREETING_QUOTA_LIMITS = Object.freeze({
  scopes: 64,
  defaultDailyPerGroup: 2,
  maxDailyPerGroup: 8,
  /** Same value as `ACTIVE_PARTICIPATION_LIMITS.globalPerHour`; unifying the two counters is P11F's scope. */
  defaultHourlyGlobal: 30,
  maxHourlyGlobal: 30,
  dayMs: 86_400_000,
  hourMs: 3_600_000,
  bytes: 16 * 1_024,
  retentionSeconds: 2 * 86_400
})

const IDENTIFIER = /^[0-9]{1,20}$/
const SCOPE_KEY = /^[0-9]{1,20}:[0-9]{1,20}$/
const casScript = `-- GROUPMATE_GREETING_QUOTA_CAS_V1
local current = redis.call('GET', KEYS[1]) or ''
if current ~= ARGV[1] then return 0 end
if string.len(ARGV[2]) > ${GREETING_QUOTA_LIMITS.bytes} then return -1 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1`

interface QuotaScope { key: string; sentAt: number[] }
interface QuotaDocument { schemaVersion: 1; scopes: QuotaScope[]; global: number[] }

function boundedLimit (value: unknown, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? Math.min(value as number, maximum)
    : fallback
}

/** A malformed or absent document starts empty; it only ever holds counters. */
function decodeDocument (raw: string | null): QuotaDocument {
  const empty: QuotaDocument = { schemaVersion: 1, scopes: [], global: [] }
  if (raw === null || raw === '' || Buffer.byteLength(raw) > GREETING_QUOTA_LIMITS.bytes) return empty
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return empty }
  const value = parsed as QuotaDocument | null
  const stamps = (list: unknown, maximum: number): number[] | null =>
    Array.isArray(list) && list.length <= maximum &&
      list.every(at => Number.isSafeInteger(at) && at >= 0)
      ? [...list as number[]]
      : null
  if (value === null || typeof value !== 'object' || value.schemaVersion !== 1 ||
    !Array.isArray(value.scopes) || value.scopes.length > GREETING_QUOTA_LIMITS.scopes) return empty
  const global = stamps(value.global, GREETING_QUOTA_LIMITS.maxHourlyGlobal)
  if (global === null) return empty
  const scopes: QuotaScope[] = []
  for (const scope of value.scopes) {
    if (scope === null || typeof scope !== 'object' || !SCOPE_KEY.test(scope.key)) return empty
    const sentAt = stamps(scope.sentAt, GREETING_QUOTA_LIMITS.maxDailyPerGroup)
    if (sentAt === null) return empty
    scopes.push({ key: scope.key, sentAt })
  }
  return { schemaVersion: 1, scopes, global }
}

export interface GreetingQuotaOptions {
  readonly client: GreetingQuotaRedisClient
  readonly now: () => number
  /** Read on every charge so a configuration reload applies without a restart. */
  readonly dailyPerGroup?: () => unknown
  readonly hourlyGlobal?: () => unknown
}

export class GreetingQuota {
  readonly #client: GreetingQuotaRedisClient
  readonly #now: () => number
  readonly #dailyPerGroup: () => unknown
  readonly #hourlyGlobal: () => unknown
  #lastNow = 0

  constructor (options: GreetingQuotaOptions) {
    this.#client = options.client
    this.#now = options.now
    this.#dailyPerGroup = options.dailyPerGroup ?? (() => undefined)
    this.#hourlyGlobal = options.hourlyGlobal ?? (() => undefined)
  }

  /** A clock that moves backwards must not un-prune a charged window. */
  #time (): number {
    const time = this.#now()
    this.#lastNow = Number.isSafeInteger(time) ? Math.max(time, this.#lastNow) : this.#lastNow
    return this.#lastNow
  }

  /**
   * Charges one greeting against both windows. Charging happens before the
   * model call, so a later send failure does not refund the slot: that keeps
   * a failing group from retrying the provider every cron tick.
   */
  async charge (botId: string, groupId: string): Promise<GreetingQuotaDecision> {
    const dailyLimit = boundedLimit(this.#dailyPerGroup(),
      GREETING_QUOTA_LIMITS.defaultDailyPerGroup, GREETING_QUOTA_LIMITS.maxDailyPerGroup)
    const hourlyLimit = boundedLimit(this.#hourlyGlobal(),
      GREETING_QUOTA_LIMITS.defaultHourlyGlobal, GREETING_QUOTA_LIMITS.maxHourlyGlobal)
    const reject = (reason: GreetingQuotaRejection, used = 0, global = 0): GreetingQuotaDecision =>
      Object.freeze({ kind: 'rejected' as const, reason, dailyUsed: used, dailyLimit, hourlyUsed: global, hourlyLimit })
    if (!IDENTIFIER.test(botId) || !IDENTIFIER.test(groupId)) return reject('identity')
    let raw: string | null
    try { raw = await this.#client.get(GREETING_QUOTA_KEY) } catch { return reject('store_unavailable') }
    if (raw !== null && typeof raw !== 'string') return reject('store_unavailable')
    const time = this.#time()
    const document = decodeDocument(raw)
    const key = `${botId}:${groupId}`
    document.global = document.global.filter(at => time - at < GREETING_QUOTA_LIMITS.hourMs)
    for (const scope of document.scopes) {
      scope.sentAt = scope.sentAt.filter(at => time - at < GREETING_QUOTA_LIMITS.dayMs)
    }
    let scope = document.scopes.find(entry => entry.key === key)
    const dailyUsed = scope?.sentAt.length ?? 0
    const hourlyUsed = document.global.length
    if (dailyUsed >= dailyLimit) return reject('daily_group', dailyUsed, hourlyUsed)
    if (hourlyUsed >= hourlyLimit) return reject('hourly_global', dailyUsed, hourlyUsed)
    if (scope === undefined) {
      // Eviction must not reset a charged window: an unknown group fails closed while every slot is live.
      document.scopes = document.scopes.filter(entry => entry.sentAt.length > 0)
      if (document.scopes.length >= GREETING_QUOTA_LIMITS.scopes) {
        return reject('scope_pressure', dailyUsed, hourlyUsed)
      }
      scope = { key, sentAt: [] }
      document.scopes.push(scope)
    }
    scope.sentAt.push(time)
    document.global.push(time)
    const next = JSON.stringify(document)
    // Match the script's byte check rather than a code-unit count.
    if (Buffer.byteLength(next) > GREETING_QUOTA_LIMITS.bytes) {
      return reject('store_unavailable', dailyUsed, hourlyUsed)
    }
    let result: unknown
    try {
      result = await this.#client.eval(casScript, { keys: [GREETING_QUOTA_KEY],
        arguments: [raw ?? '', next, String(GREETING_QUOTA_LIMITS.retentionSeconds)] })
    } catch { return reject('store_unavailable', dailyUsed, hourlyUsed) }
    if (Number(result) !== 1) {
      return reject(Number(result) === 0 ? 'conflict' : 'store_unavailable', dailyUsed, hourlyUsed)
    }
    return Object.freeze({ kind: 'allowed' as const,
      dailyUsed: dailyUsed + 1, dailyLimit, hourlyUsed: hourlyUsed + 1, hourlyLimit })
  }
}
