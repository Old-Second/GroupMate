import {
  createHmac,
  randomBytes as secureRandomBytes,
  randomUUID,
  timingSafeEqual
} from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import {
  lstat,
  link,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle
} from 'node:fs/promises'
import path from 'node:path'
import type { SessionAddress } from '../agent/contracts/identity.js'

export interface ProviderIsolationDiagnostic {
  readonly event: 'groupmate.provider_isolation.failure'
  readonly code: 'secret_unavailable'
}

export type ProviderIsolationIdState =
  | Readonly<{
      kind: 'ready'
      cacheIsolationId: string
    }>
  | Readonly<{
      kind: 'unavailable'
      code: 'secret_unavailable'
    }>

export interface ProviderIsolationIdSource {
  resolve(address: SessionAddress): Promise<ProviderIsolationIdState>
}

export interface ProviderIsolationIdSourceOptions {
  readonly directory: string
  readonly trustedRoot: string
  readonly randomBytes?: (size: number) => Uint8Array
  readonly ownerUid?: number
  readonly onDiagnostic?: (diagnostic: ProviderIsolationDiagnostic) => void
}

export type ProviderIsolationIdSourceFactory = () => ProviderIsolationIdSource

interface BoundIsolationDirectory {
  readonly root: string
  sync(): Promise<void>
}

type SecretState =
  | Readonly<{ kind: 'ready'; secret: Buffer }>
  | Readonly<{ kind: 'unavailable' }>

const SECRET_BYTES = 32
const KEY_FILE_NAME = 'provider-isolation.key'
const DOMAIN = 'groupmate.deepseek.cache-isolation.v1'
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const KEY_READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const TEMP_WRITE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
  constants.O_NOFOLLOW | constants.O_NONBLOCK
const DIAGNOSTIC: ProviderIsolationDiagnostic = Object.freeze({
  event: 'groupmate.provider_isolation.failure',
  code: 'secret_unavailable'
})
const UNAVAILABLE: ProviderIsolationIdState = Object.freeze({
  kind: 'unavailable',
  code: 'secret_unavailable'
})

class MissingIsolationKeyError extends Error {}

function errorCodeIs (error: unknown, code: string): boolean {
  return error !== null && typeof error === 'object' &&
    'code' in error && error.code === code
}

function ownerUid (configured: number | undefined): number {
  const value = configured ?? (typeof process.getuid === 'function' ? process.getuid() : 0)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('provider isolation owner is invalid')
  }
  return value
}

function ownerUidValue (configured: number | undefined): bigint {
  return BigInt(ownerUid(configured))
}

function relativeDescendant (root: string, target: string): string {
  if (!path.isAbsolute(root) || !path.isAbsolute(target)) {
    throw new TypeError('provider isolation directory boundary is invalid')
  }
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)) {
    throw new TypeError('provider isolation directory boundary is invalid')
  }
  return relative
}

function assertDirectory (
  details: BigIntStats,
  strict: boolean,
  expectedUid: bigint
): void {
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new TypeError('provider isolation ancestor is invalid')
  }
  if (strict && ((details.mode & 0o777n) !== 0o700n || details.uid !== expectedUid)) {
    throw new TypeError('provider isolation directory is invalid')
  }
}

interface PreparedIdentityDirectory {
  readonly path: string
  readonly trustedRootRealpath: string
  readonly details: BigIntStats
}

async function ensureIdentityDirectory (
  directory: string,
  trustedRoot: string,
  expectedUid: bigint
): Promise<PreparedIdentityDirectory> {
  const relative = relativeDescendant(trustedRoot, directory)
  const trustedRootRealpath = await realpath(trustedRoot)
  let current = trustedRootRealpath
  const segments = relative.split(path.sep)
  let finalDetails: BigIntStats | undefined
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment)
    let details: BigIntStats
    try {
      details = await lstat(current, { bigint: true })
    } catch (error) {
      if (!errorCodeIs(error, 'ENOENT')) throw error
      try {
        await mkdir(current, { mode: 0o700 })
      } catch (mkdirError) {
        if (!errorCodeIs(mkdirError, 'EEXIST')) throw mkdirError
      }
      details = await lstat(current, { bigint: true })
    }
    assertDirectory(details, index === segments.length - 1, expectedUid)
    if (index === segments.length - 1) finalDetails = details
  }
  if (finalDetails === undefined) {
    throw new TypeError('provider isolation directory boundary is invalid')
  }
  return Object.freeze({
    path: current,
    trustedRootRealpath,
    details: finalDetails
  })
}

function assertKeyDetails (details: BigIntStats, expectedUid: bigint): void {
  if (!details.isFile() || details.isSymbolicLink() || details.uid !== expectedUid ||
    (details.mode & 0o777n) !== 0o600n || details.size !== BigInt(SECRET_BYTES)) {
    throw new TypeError('provider isolation key is invalid')
  }
}

function assertTemporaryDetails (details: BigIntStats, expectedUid: bigint): void {
  if (!details.isFile() || details.isSymbolicLink() || details.uid !== expectedUid ||
    (details.mode & 0o777n) !== 0o600n || details.size !== 0n) {
    throw new TypeError('provider isolation temporary file is invalid')
  }
}

async function readSecret (
  keyPath: string,
  expectedUid: bigint
): Promise<Buffer> {
  let pathDetails: BigIntStats
  try {
    pathDetails = await lstat(keyPath, { bigint: true })
  } catch (error) {
    if (errorCodeIs(error, 'ENOENT')) throw new MissingIsolationKeyError()
    throw error
  }
  assertKeyDetails(pathDetails, expectedUid)
  const file = await open(keyPath, KEY_READ_FLAGS)
  try {
    const opened = await file.stat({ bigint: true })
    assertKeyDetails(opened, expectedUid)
    if (opened.dev !== pathDetails.dev || opened.ino !== pathDetails.ino) {
      throw new TypeError('provider isolation key identity changed')
    }
    const bytes = Buffer.alloc(SECRET_BYTES + 1)
    let offset = 0
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, offset)
      if (result.bytesRead === 0) break
      offset += result.bytesRead
    }
    if (offset !== SECRET_BYTES) throw new TypeError('provider isolation key length is invalid')
    const current = await lstat(keyPath, { bigint: true })
    assertKeyDetails(current, expectedUid)
    if (current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new TypeError('provider isolation key identity changed')
    }
    return Buffer.from(bytes.subarray(0, SECRET_BYTES))
  } finally {
    await file.close()
  }
}

async function writeAll (file: FileHandle, secret: Buffer): Promise<void> {
  let offset = 0
  while (offset < secret.length) {
    const result = await file.write(secret, offset, secret.length - offset, offset)
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      throw new TypeError('provider isolation temporary write failed')
    }
    offset += result.bytesWritten
  }
}

async function boundOperationRoot (
  directory: FileHandle,
  canonicalDirectory: string,
  opened: BigIntStats
): Promise<string> {
  if (process.platform !== 'linux') {
    throw new TypeError('provider isolation directory binding is unavailable')
  }
  const root = `/proc/self/fd/${directory.fd}`
  const rootRealpath = await realpath(root)
  const rootDetails = await directory.stat({ bigint: true })
  if (rootRealpath !== canonicalDirectory || rootDetails.dev !== opened.dev ||
    rootDetails.ino !== opened.ino) {
    throw new TypeError('provider isolation directory binding changed')
  }
  return root
}

async function createSecret (
  directory: BoundIsolationDirectory,
  expectedUid: bigint,
  randomBytes: (size: number) => Uint8Array
): Promise<Buffer> {
  const generated = Buffer.from(randomBytes(SECRET_BYTES))
  if (generated.length !== SECRET_BYTES) {
    throw new TypeError('provider isolation random source is invalid')
  }
  const temporaryPath = path.join(
    directory.root,
    `.provider-isolation.${process.pid}.${randomUUID()}.tmp`
  )
  const finalPath = path.join(directory.root, KEY_FILE_NAME)
  let temporary: FileHandle | undefined
  let temporaryDetails: BigIntStats | undefined
  let temporaryExists = false
  try {
    temporary = await open(temporaryPath, TEMP_WRITE_FLAGS, 0o600)
    temporaryExists = true
    temporaryDetails = await temporary.stat({ bigint: true })
    assertTemporaryDetails(temporaryDetails, expectedUid)
    await writeAll(temporary, generated)
    await temporary.sync()
    await temporary.close()
    temporary = undefined
    try {
      await link(temporaryPath, finalPath)
    } catch (error) {
      if (!errorCodeIs(error, 'EEXIST')) throw error
      await unlink(temporaryPath)
      temporaryExists = false
      const winner = await readSecret(finalPath, expectedUid)
      await directory.sync()
      return winner
    }
    const published = await lstat(finalPath, { bigint: true })
    if (temporaryDetails === undefined || published.dev !== temporaryDetails.dev ||
      published.ino !== temporaryDetails.ino) {
      throw new TypeError('provider isolation publication identity changed')
    }
    await unlink(temporaryPath)
    temporaryExists = false
    const winner = await readSecret(finalPath, expectedUid)
    if (!timingSafeEqual(winner, generated)) {
      throw new TypeError('provider isolation publication changed')
    }
    await directory.sync()
    return winner
  } finally {
    if (temporary !== undefined) await temporary.close().catch(() => undefined)
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined)
  }
}

async function loadOrCreateSecret (
  configuredDirectory: string,
  trustedRoot: string,
  expectedUid: bigint,
  randomBytes: (size: number) => Uint8Array
): Promise<Buffer> {
  if (process.platform !== 'linux') {
    throw new TypeError('provider isolation directory binding is unavailable')
  }
  const prepared = await ensureIdentityDirectory(
    configuredDirectory,
    trustedRoot,
    expectedUid
  )
  const directory = await open(prepared.path, DIRECTORY_FLAGS)
  try {
    const opened = await directory.stat({ bigint: true })
    const current = await lstat(prepared.path, { bigint: true })
    assertDirectory(opened, true, expectedUid)
    assertDirectory(current, true, expectedUid)
    if (opened.dev !== current.dev || opened.ino !== current.ino ||
      opened.dev !== prepared.details.dev || opened.ino !== prepared.details.ino) {
      throw new TypeError('provider isolation directory identity changed')
    }
    const trustedRootRealpath = await realpath(trustedRoot)
    const canonicalDirectory = await realpath(prepared.path)
    if (trustedRootRealpath !== prepared.trustedRootRealpath ||
      canonicalDirectory !== prepared.path) {
      throw new TypeError('provider isolation directory boundary changed')
    }
    relativeDescendant(trustedRootRealpath, canonicalDirectory)
    const root = await boundOperationRoot(directory, canonicalDirectory, opened)
    return await loadOrCreateBoundSecret(Object.freeze({
      root,
      sync: async () => { await directory.sync() }
    }), expectedUid, randomBytes)
  } finally {
    await directory.close()
  }
}

async function loadOrCreateBoundSecret (
  directory: BoundIsolationDirectory,
  expectedUid: bigint,
  randomBytes: (size: number) => Uint8Array
): Promise<Buffer> {
  if (!path.isAbsolute(directory.root) || typeof directory.sync !== 'function') {
    throw new TypeError('provider isolation directory capability is invalid')
  }
  try {
    return await readSecret(path.join(directory.root, KEY_FILE_NAME), expectedUid)
  } catch (error) {
    if (!(error instanceof MissingIsolationKeyError)) throw error
    return await createSecret(directory, expectedUid, randomBytes)
  }
}

function identifierBytes (value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('provider isolation address is invalid')
  }
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length === 0 || bytes.length > 4_096) {
    throw new TypeError('provider isolation address is invalid')
  }
  return bytes
}

function updateFramed (hmac: ReturnType<typeof createHmac>, value: Buffer): void {
  const length = Buffer.allocUnsafe(4)
  length.writeUInt32BE(value.length)
  hmac.update(length)
  hmac.update(value)
}

export function deriveDeepSeekCacheIsolationId (
  secretValue: Uint8Array,
  address: SessionAddress
): string {
  const secret = Buffer.from(secretValue)
  if (secret.length !== SECRET_BYTES || address === null || typeof address !== 'object') {
    throw new TypeError('provider isolation input is invalid')
  }
  const bot = identifierBytes(address.botId)
  const scope = address.scope
  if (scope === null || typeof scope !== 'object') {
    throw new TypeError('provider isolation address is invalid')
  }
  const group = scope.kind === 'group' || scope.kind === 'group_user'
  if (!group && scope.kind !== 'private') {
    throw new TypeError('provider isolation address is invalid')
  }
  const tag = group ? 'g' : 'u'
  const target = group
    ? identifierBytes(scope.groupId)
    : identifierBytes(scope.userId)
  const hmac = createHmac('sha256', secret)
  for (const field of [
    Buffer.from(DOMAIN, 'utf8'),
    Buffer.from(tag, 'ascii'),
    bot,
    target
  ]) updateFramed(hmac, field)
  return `gm_${tag}_${hmac.digest('base64url')}`
}

class LazyProviderIsolationIdSource implements ProviderIsolationIdSource {
  readonly #loadSecret: () => Promise<Buffer>
  readonly #onDiagnostic?: (diagnostic: ProviderIsolationDiagnostic) => void
  #state: Promise<SecretState> | undefined

  constructor (
    loadSecret: () => Promise<Buffer>,
    onDiagnostic: ((diagnostic: ProviderIsolationDiagnostic) => void) | undefined
  ) {
    this.#loadSecret = loadSecret
    this.#onDiagnostic = onDiagnostic
  }

  async resolve (address: SessionAddress): Promise<ProviderIsolationIdState> {
    const state = await this.#ready()
    if (state.kind === 'unavailable') return UNAVAILABLE
    try {
      return Object.freeze({
        kind: 'ready',
        cacheIsolationId: deriveDeepSeekCacheIsolationId(state.secret, address)
      })
    } catch {
      this.#report()
      return UNAVAILABLE
    }
  }

  #ready (): Promise<SecretState> {
    this.#state ??= this.#loadSecret()
      .then(secret => Object.freeze({ kind: 'ready' as const, secret }))
      .catch(() => {
        this.#report()
        return Object.freeze({ kind: 'unavailable' as const })
      })
    return this.#state
  }

  #report (): void {
    try {
      this.#onDiagnostic?.(DIAGNOSTIC)
    } catch {}
  }
}

export function createProviderIsolationIdSource (
  options: ProviderIsolationIdSourceOptions
): ProviderIsolationIdSource {
  if (typeof options.directory !== 'string' || typeof options.trustedRoot !== 'string') {
    throw new TypeError('provider isolation source options are invalid')
  }
  const expectedUid = ownerUidValue(options.ownerUid)
  const randomBytes = options.randomBytes ?? secureRandomBytes
  return new LazyProviderIsolationIdSource(
    async () => await loadOrCreateSecret(
      options.directory,
      options.trustedRoot,
      expectedUid,
      randomBytes
    ),
    options.onDiagnostic
  )
}
