import type { ApprovalRecord, ApprovalStore } from '../../agent/tools/approval-store.js'

export interface RedisToolControlClient {
  get(key: string): Promise<string | null>
  getDel(key: string): Promise<string | null>
  set(key: string, value: string, options: { EX: number; NX?: boolean; XX?: boolean }): Promise<unknown>
  del(key: string): Promise<number>
}

export interface RedisApprovalStoreOptions {
  readonly client: RedisToolControlClient
  readonly botIdHash: string
}

const namespace = 'GROUPMATE:TOOL:APPROVAL:v1:'
const maxRecordBytes = 16 * 1024
const codePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const profiles = new Set(['compatible', 'safe', 'strict'])
const storedKeys = [
  'schemaVersion', 'rawVersion', 'toolName', 'toolVersion', 'profile', 'runId', 'callId',
  'snapshotId', 'argumentHash', 'pendingCallId', 'botIdHash', 'actorIdHash', 'channelHash',
  'targetHash', 'summaryCode', 'createdAt', 'expiresAt'
] as const

function boundedCode (value: unknown): value is string {
  return typeof value === 'string' && codePattern.test(value)
}

function validDate (value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value))
}

function exactKeys (value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && actual.every(key => keys.includes(key))
}

function validateTtl (ttlSeconds: number): void {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 300) {
    throw new TypeError('tool control TTL is invalid')
  }
}

function storedRecord (record: ApprovalRecord): Record<string, unknown> {
  return {
    schemaVersion: 1,
    rawVersion: record.rawVersion,
    toolName: record.toolName,
    toolVersion: 1,
    profile: record.profile,
    runId: record.runId,
    callId: record.callId,
    snapshotId: record.snapshotId,
    argumentHash: record.argumentHash,
    pendingCallId: record.pendingCallId,
    botIdHash: record.botIdHash,
    actorIdHash: record.actorIdHash,
    channelHash: record.channelHash,
    targetHash: record.targetHash,
    summaryCode: record.summaryCode,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt
  }
}

function parseRecord (raw: string, tokenHash: string, expectedBotIdHash: string): ApprovalRecord | null {
  if (Buffer.byteLength(raw, 'utf8') > maxRecordBytes) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (!exactKeys(record, storedKeys) || record.schemaVersion !== 1 || record.toolVersion !== 1 ||
    !profiles.has(record.profile as string) || record.botIdHash !== expectedBotIdHash ||
    !validDate(record.createdAt) || !validDate(record.expiresAt)) return null
  for (const key of storedKeys) {
    if (['schemaVersion', 'toolVersion', 'profile', 'createdAt', 'expiresAt'].includes(key)) continue
    if (!boundedCode(record[key])) return null
  }
  return Object.freeze({ ...record, tokenHash }) as unknown as ApprovalRecord
}

export function redisApprovalKey (botIdHash: string, tokenHash: string): string {
  if (!boundedCode(botIdHash) || !boundedCode(tokenHash)) throw new TypeError('approval key hash is invalid')
  return `${namespace}${encodeURIComponent(botIdHash)}:${encodeURIComponent(tokenHash)}`
}

export class RedisApprovalStore implements ApprovalStore {
  readonly #client: RedisToolControlClient
  readonly #botIdHash: string

  constructor (options: RedisApprovalStoreOptions) {
    if (!boundedCode(options.botIdHash)) throw new TypeError('bot namespace hash is invalid')
    this.#client = options.client
    this.#botIdHash = options.botIdHash
  }

  async create (record: ApprovalRecord, ttlSeconds: number): Promise<void> {
    validateTtl(ttlSeconds)
    if (record.botIdHash !== this.#botIdHash || !boundedCode(record.tokenHash)) {
      throw new TypeError('approval record namespace is invalid')
    }
    const stored = storedRecord(record)
    const raw = JSON.stringify(stored)
    if (parseRecord(raw, record.tokenHash, this.#botIdHash) === null || Buffer.byteLength(raw, 'utf8') > maxRecordBytes) {
      throw new TypeError('approval record is invalid')
    }
    const result = await this.#client.set(
      redisApprovalKey(this.#botIdHash, record.tokenHash), raw, { EX: ttlSeconds, NX: true }
    )
    if (result === null) throw new Error('approval record already exists')
  }

  async get (tokenHash: string): Promise<ApprovalRecord | null> {
    const key = redisApprovalKey(this.#botIdHash, tokenHash)
    const raw = await this.#client.get(key)
    if (raw === null) return null
    const record = parseRecord(raw, tokenHash, this.#botIdHash)
    if (record === null) await this.#client.del(key)
    return record
  }

  async consume (tokenHash: string, expectedRawVersion: string): Promise<ApprovalRecord | null> {
    if (!boundedCode(expectedRawVersion)) return null
    const key = redisApprovalKey(this.#botIdHash, tokenHash)
    const raw = await this.#client.get(key)
    if (raw === null) return null
    const checked = parseRecord(raw, tokenHash, this.#botIdHash)
    if (checked === null) {
      await this.#client.del(key)
      return null
    }
    if (checked.rawVersion !== expectedRawVersion) return null
    const consumedRaw = await this.#client.getDel(key)
    if (consumedRaw !== raw) return null
    return parseRecord(consumedRaw, tokenHash, this.#botIdHash)
  }
}
