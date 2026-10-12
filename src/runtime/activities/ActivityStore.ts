export type ActivityState = 'pending' | 'claimed' | 'dispatching' | 'completed' | 'cancelled' | 'expired' | 'failed' | 'indeterminate'
export interface GroupActivity {
  schemaVersion: 1
  id: string
  kind: 'reminder' | 'poll'
  botId: string
  groupId: string
  ownerId: string
  requestKey: string
  createdAt: number
  updatedAt: number
  dueAt: number
  state: ActivityState
  token: string
  leaseUntil: number
  content: string
  timeZone: string
  intervalMs: number
  remaining: number
  options: string[]
  multiple: boolean
  votes: Record<string, number[]>
}

export interface ActivityData { schemaVersion: 1; records: GroupActivity[] }
export interface ActivityRedisClient {
  get(key: string): Promise<string | null>
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>
}
export const ACTIVITY_KEY = 'GROUPMATE:ACTIVITIES:v1'
export const ACTIVITY_LIMITS = Object.freeze({ records: 128, bytes: 64 * 1024, perGroup: 24, perActor: 8,
  pollsPerGroup: 8, voters: 100, retentionMs: 7 * 86400000, horizonMs: 90 * 86400000, leaseMs: 120000 })
const casScript = `-- GROUPMATE_ACTIVITY_CAS_V1
local current = redis.call('GET', KEYS[1]) or ''
if current ~= ARGV[1] then return 0 end
if string.len(ARGV[2]) > 65536 then return -1 end
redis.call('SET', KEYS[1], ARGV[2])
return 1`

function validRecord (r: GroupActivity): boolean {
  return r !== null && typeof r === 'object' && r.schemaVersion === 1 &&
    /^[a-f0-9]{16}$/.test(r.id) && ['reminder', 'poll'].includes(r.kind) &&
    [r.botId, r.groupId, r.ownerId].every(value => typeof value === 'string' && /^[0-9]{1,20}$/.test(value)) &&
    /^[a-f0-9]{64}$/.test(r.requestKey) &&
    [r.createdAt, r.updatedAt, r.dueAt, r.leaseUntil, r.intervalMs, r.remaining].every(value => Number.isSafeInteger(value) && value >= 0) &&
    r.intervalMs <= 30 * 86400000 && r.remaining <= 30 &&
    ['pending', 'claimed', 'dispatching', 'completed', 'cancelled', 'expired', 'failed', 'indeterminate'].includes(r.state) &&
    typeof r.token === 'string' && (r.token === '' || /^[a-f0-9]{32}$/.test(r.token)) &&
    typeof r.content === 'string' && r.content.length > 0 && r.content.length <= 500 &&
    typeof r.timeZone === 'string' && r.timeZone.length > 0 && r.timeZone.length <= 80 &&
    Array.isArray(r.options) && r.options.length <= 10 && r.options.every(v => typeof v === 'string' && v.length > 0 && v.length <= 80) &&
    typeof r.multiple === 'boolean' && r.votes !== null && typeof r.votes === 'object' && !Array.isArray(r.votes) &&
    Object.keys(r.votes).length <= ACTIVITY_LIMITS.voters && Object.entries(r.votes).every(([key, votes]) =>
      /^[a-f0-9]{64}$/.test(key) && Array.isArray(votes) && votes.length > 0 && votes.length <= r.options.length &&
      new Set(votes).size === votes.length && votes.every(v => Number.isSafeInteger(v) && v >= 1 && v <= r.options.length)) &&
    (r.kind === 'poll' ? r.options.length >= 2 && r.intervalMs === 0 && r.remaining <= 1 : r.options.length === 0 && Object.keys(r.votes).length === 0)
}

export function decodeActivityData (raw: string | null): ActivityData {
  if (raw === null) return { schemaVersion: 1, records: [] }
  if (Buffer.byteLength(raw) > ACTIVITY_LIMITS.bytes) throw new TypeError('activity store exceeds budget')
  const data = JSON.parse(raw) as ActivityData
  validateActivityData(data)
  return data
}

function validateActivityData (data: ActivityData): void {
  if (data === null || data.schemaVersion !== 1 || !Array.isArray(data.records) || data.records.length > ACTIVITY_LIMITS.records ||
    !data.records.every(validRecord) || new Set(data.records.map(r => r.id)).size !== data.records.length) throw new TypeError('activity store is invalid')
}

/** One bounded key; whole-state CAS prevents lost votes, double claims and cancellation races. */
export class ActivityStore {
  #cachedRaw: string | null | undefined
  #cachedData: ActivityData | null = null
  constructor (readonly client: ActivityRedisClient, readonly key = ACTIVITY_KEY) {}
  #snapshot (raw: string | null): ActivityData {
    if (raw === this.#cachedRaw && this.#cachedData !== null) return this.#cachedData
    const data = decodeActivityData(raw)
    for (const r of data.records) {
      Object.freeze(r.options)
      for (const votes of Object.values(r.votes)) Object.freeze(votes)
      Object.freeze(r.votes)
      Object.freeze(r)
    }
    Object.freeze(data.records)
    Object.freeze(data)
    this.#cachedRaw = raw
    this.#cachedData = data
    return data
  }
  // The cached projection is immutable and is reused only after GET confirms identical wire bytes.
  async read (): Promise<Readonly<ActivityData>> { return this.#snapshot(await this.client.get(this.key)) }
  async update<T> (mutate: (data: ActivityData) => T, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      signal?.throwIfAborted()
      const previous = await this.client.get(this.key)
      const data = structuredClone(this.#snapshot(previous))
      const result = mutate(data)
      validateActivityData(data)
      const next = JSON.stringify(data)
      if (Buffer.byteLength(next) > ACTIVITY_LIMITS.bytes) throw new TypeError('activity store exceeds budget')
      signal?.throwIfAborted()
      if (next === previous) return result
      const receipt = await this.client.eval(casScript, { keys: [this.key], arguments: [previous ?? '', next] })
      if (receipt === 1) return result
      if (receipt !== 0) throw new Error('activity store write failed')
    }
    throw new Error('activity store is busy')
  }
}

export function activeActivity (r: GroupActivity): boolean { return ['pending', 'claimed', 'dispatching'].includes(r.state) }
export function pruneActivities (data: ActivityData, now: number): void {
  data.records = data.records.filter(r => activeActivity(r) || now - r.updatedAt < ACTIVITY_LIMITS.retentionMs)
}
