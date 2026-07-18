import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  constants,
  mkdirSync,
  renameSync,
  symlinkSync
} from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { after, test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import {
  createProviderIsolationIdSource,
  deriveDeepSeekCacheIsolationId,
  type ProviderIsolationDiagnostic,
  type ProviderIsolationIdSource
} from '../../src/runtime/provider-isolation-id.js'

const execFileAsync = promisify(execFile)
const KEY_BYTES = 32
const GROUP_ID_PATTERN = /^gm_g_[A-Za-z0-9_-]{43}$/
const USER_ID_PATTERN = /^gm_u_[A-Za-z0-9_-]{43}$/
const boundFileSystemTest = process.platform === 'linux' ? test : test.skip

interface BoundSecretLoader {
  (
    directory: Readonly<{ root: string; sync(): Promise<void> }>,
    expectedUid: bigint,
    randomBytes: (size: number) => Uint8Array
  ): Promise<Buffer>
}

let boundSecretLoaderPromise: Promise<BoundSecretLoader> | undefined
let boundSecretHarnessPath: string | undefined

async function boundSecretLoader (): Promise<BoundSecretLoader> {
  boundSecretLoaderPromise ??= (async () => {
    const [{ ModuleKind, ScriptTarget, transpileModule }, sourceText] = await Promise.all([
      import('typescript'),
      readFile(path.resolve('src/runtime/provider-isolation-id.ts'), 'utf8')
    ])
    const transformed = `${sourceText}\nexport { loadOrCreateBoundSecret as __loadBoundSecretForTest }\n`
    const output = transpileModule(transformed, {
      compilerOptions: {
        module: ModuleKind.ES2022,
        target: ScriptTarget.ES2022,
        verbatimModuleSyntax: true
      }
    }).outputText
    boundSecretHarnessPath = path.join(
      '/tmp',
      `groupmate-provider-isolation-harness-${process.pid}-${randomUUID()}.mjs`
    )
    await writeFile(boundSecretHarnessPath, output, { mode: 0o600 })
    const loaded = await import(pathToFileURL(boundSecretHarnessPath).href) as Readonly<{
      __loadBoundSecretForTest: BoundSecretLoader
    }>
    return loaded.__loadBoundSecretForTest
  })()
  return await boundSecretLoaderPromise
}

after(async () => {
  if (boundSecretHarnessPath !== undefined) {
    await rm(boundSecretHarnessPath, { force: true })
  }
})

function groupAddress (
  botId = 'bot-private-fragment-123456',
  groupId = 'group-private-fragment-654321'
): SessionAddress {
  return Object.freeze({
    botId,
    scope: Object.freeze({ kind: 'group' as const, groupId })
  })
}

function groupUserAddress (
  botId = 'bot-private-fragment-123456',
  groupId = 'group-private-fragment-654321',
  userId = 'actor-must-not-affect-group-cache'
): SessionAddress {
  return Object.freeze({
    botId,
    scope: Object.freeze({ kind: 'group_user' as const, groupId, userId })
  })
}

function privateAddress (
  botId = 'bot-private-fragment-123456',
  userId = 'user-private-fragment-987654'
): SessionAddress {
  return Object.freeze({
    botId,
    scope: Object.freeze({ kind: 'private' as const, userId })
  })
}

function deterministicSecret (byte: number): (size: number) => Buffer {
  return size => Buffer.alloc(size, byte)
}

function sourceFor (
  root: string,
  byte: number,
  diagnostics: ProviderIsolationDiagnostic[] = [],
  ownerUid?: number
): ProviderIsolationIdSource {
  return createProviderIsolationIdSource({
    trustedRoot: root,
    directory: path.join(root, 'data', 'identity'),
    randomBytes: deterministicSecret(byte),
    onDiagnostic: diagnostic => { diagnostics.push(diagnostic) },
    ...(ownerUid === undefined ? {} : { ownerUid })
  })
}

function boundStateSourceFor (
  root: string,
  byte: number,
  diagnostics: ProviderIsolationDiagnostic[] = [],
  ownerUid?: number
): ProviderIsolationIdSource {
  const expectedUid = BigInt(
    ownerUid ?? (typeof process.getuid === 'function' ? process.getuid() : 0)
  )
  let secret: Promise<Buffer> | undefined
  let reported = false
  return Object.freeze({
    resolve: async (address: SessionAddress) => {
      secret ??= boundSecretLoader().then(async load => await load(
        Object.freeze({
          root: path.join(root, 'data', 'identity'),
          sync: async () => {}
        }),
        expectedUid,
        deterministicSecret(byte)
      ))
      try {
        return Object.freeze({
          kind: 'ready' as const,
          cacheIsolationId: deriveDeepSeekCacheIsolationId(await secret, address)
        })
      } catch {
        if (!reported) {
          reported = true
          diagnostics.push(Object.freeze({
            event: 'groupmate.provider_isolation.failure',
            code: 'secret_unavailable'
          }))
        }
        return Object.freeze({
          kind: 'unavailable' as const,
          code: 'secret_unavailable' as const
        })
      }
    }
  })
}

async function withTemporaryRoot (
  callback: (root: string) => Promise<void>
): Promise<void> {
  const temporaryBase = process.platform === 'win32' ? os.tmpdir() : '/tmp'
  const root = await mkdtemp(path.join(temporaryBase, 'groupmate-pi-'))
  try {
    await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function prepareExistingKey (
  root: string,
  bytes: Buffer,
  mode = 0o600
): Promise<string> {
  const directory = path.join(root, 'data', 'identity')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const keyPath = path.join(directory, 'provider-isolation.key')
  await writeFile(keyPath, bytes, { mode })
  await chmod(keyPath, mode)
  return keyPath
}

async function assertUnavailable (
  source: ProviderIsolationIdSource
): Promise<void> {
  const state = await source.resolve(groupAddress())
  assert.deepEqual(state, {
    kind: 'unavailable',
    code: 'secret_unavailable'
  })
  assert.equal(Object.isFrozen(state), true)
}

test('DeepSeek isolation ID uses a fixed framed HMAC vector and hides raw identities', () => {
  const secret = Buffer.from(Array.from({ length: KEY_BYTES }, (_, index) => index))
  const address = groupAddress('bot-测试', 'group:alpha|beta')

  const derived = deriveDeepSeekCacheIsolationId(secret, address)

  assert.equal(derived, 'gm_g_MIGx_UqTY9PsH0-foOeXsoSNfUo0jTiLTjZ3K_5sLTA')
  assert.match(derived, GROUP_ID_PATTERN)
  assert.equal(derived.length, 48)
  assert.doesNotMatch(derived, /bot|group|测试|alpha|beta/u)
  assert.notEqual(
    deriveDeepSeekCacheIsolationId(secret, groupAddress('a', 'bc')),
    deriveDeepSeekCacheIsolationId(secret, groupAddress('ab', 'c'))
  )
})

test('isolation scope is stable per bot and group while private users remain separate', () => {
  const secret = Buffer.alloc(KEY_BYTES, 0x5a)
  const group = groupAddress()
  const groupUser = groupUserAddress()
  const privateOne = privateAddress()
  const privateTwo = privateAddress(undefined, 'different-private-user')

  const groupId = deriveDeepSeekCacheIsolationId(secret, group)
  assert.equal(groupId, deriveDeepSeekCacheIsolationId(secret, group))
  assert.equal(groupId, deriveDeepSeekCacheIsolationId(secret, groupUser))
  assert.match(groupId, GROUP_ID_PATTERN)
  assert.match(deriveDeepSeekCacheIsolationId(secret, privateOne), USER_ID_PATTERN)
  assert.notEqual(
    deriveDeepSeekCacheIsolationId(secret, privateOne),
    deriveDeepSeekCacheIsolationId(secret, privateTwo)
  )
  assert.notEqual(groupId, deriveDeepSeekCacheIsolationId(secret, groupAddress('other-bot')))
})

test('non-Linux source fails closed before filesystem or random-secret initialization', {
  skip: process.platform === 'linux'
}, async () => {
  await withTemporaryRoot(async root => {
    const diagnostics: ProviderIsolationDiagnostic[] = []
    let randomCalls = 0
    const source = createProviderIsolationIdSource({
      trustedRoot: root,
      directory: path.join(root, 'data', 'identity'),
      randomBytes: size => {
        randomCalls += 1
        return Buffer.alloc(size, 0x31)
      },
      onDiagnostic: diagnostic => { diagnostics.push(diagnostic) }
    })

    await assertUnavailable(source)

    assert.equal(randomCalls, 0)
    assert.deepEqual(await readdir(root), [])
    assert.deepEqual(diagnostics, [{
      event: 'groupmate.provider_isolation.failure',
      code: 'secret_unavailable'
    }])
  })
})

boundFileSystemTest('source lazily creates one raw 32-byte secret with exact directory and file modes', async () => {
  await withTemporaryRoot(async root => {
    const diagnostics: ProviderIsolationDiagnostic[] = []
    const source = sourceFor(root, 0x31, diagnostics)
    assert.deepEqual(await readdir(root), [])

    const first = await source.resolve(groupAddress())
    const second = await source.resolve(groupAddress())

    assert.equal(first.kind, 'ready')
    assert.deepEqual(second, first)
    assert.equal(Object.isFrozen(first), true)
    if (first.kind !== 'ready') return
    assert.match(first.cacheIsolationId, GROUP_ID_PATTERN)
    const directory = path.join(root, 'data', 'identity')
    const keyPath = path.join(directory, 'provider-isolation.key')
    assert.equal((await lstat(directory)).mode & 0o777, 0o700)
    assert.equal((await lstat(keyPath)).mode & 0o777, 0o600)
    assert.deepEqual(await readFile(keyPath), Buffer.alloc(KEY_BYTES, 0x31))
    assert.deepEqual(diagnostics, [])
    assert.deepEqual((await readdir(directory)).sort(), ['provider-isolation.key'])
  })
})

test('bound-directory state machine creates one exact-mode key without residual temporary files', async () => {
  await withTemporaryRoot(async root => {
    const directory = path.join(root, 'data', 'identity')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)

    const state = await boundStateSourceFor(root, 0x30).resolve(groupAddress())

    assert.equal(state.kind, 'ready')
    const keyPath = path.join(directory, 'provider-isolation.key')
    assert.equal((await lstat(keyPath)).mode & 0o777, 0o600)
    assert.deepEqual(await readFile(keyPath), Buffer.alloc(KEY_BYTES, 0x30))
    assert.deepEqual(await readdir(directory), ['provider-isolation.key'])
  })
})

test('independent concurrent sources atomically converge on the same complete winner', async () => {
  await withTemporaryRoot(async root => {
    const directory = path.join(root, 'data', 'identity')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const sources = Array.from({ length: 12 }, (_, index) => (
      boundStateSourceFor(root, index + 1)
    ))
    const states = await Promise.all(sources.map(async source => (
      await source.resolve(groupAddress())
    )))

    assert.equal(states.every(state => state.kind === 'ready'), true)
    assert.equal(new Set(states.map(state => (
      state.kind === 'ready' ? state.cacheIsolationId : state.code
    ))).size, 1)
    const key = await readFile(path.join(root, 'data', 'identity', 'provider-isolation.key'))
    assert.equal(key.length, KEY_BYTES)
    assert.equal(new Set(key).size, 1)
    assert.ok(key[0] !== undefined && key[0] >= 1 && key[0] <= 12)
  })
})

test('an incomplete residual temporary file can never become the published secret', async () => {
  await withTemporaryRoot(async root => {
    const directory = path.join(root, 'data', 'identity')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const stale = path.join(directory, '.provider-isolation.incomplete.tmp')
    await writeFile(stale, Buffer.alloc(7, 0x7f), { mode: 0o600 })
    const state = await boundStateSourceFor(root, 0x42).resolve(groupAddress())

    assert.equal(state.kind, 'ready')
    assert.deepEqual(
      await readFile(path.join(directory, 'provider-isolation.key')),
      Buffer.alloc(KEY_BYTES, 0x42)
    )
    assert.deepEqual(await readFile(stale), Buffer.alloc(7, 0x7f))
  })
})

test('invalid existing keys are rejected without chmod, replacement or regeneration', async () => {
  const cases = [
    { name: 'short', bytes: Buffer.alloc(31, 0x11), mode: 0o600 },
    { name: 'long', bytes: Buffer.alloc(33, 0x12), mode: 0o600 },
    { name: 'world-readable', bytes: Buffer.alloc(KEY_BYTES, 0x13), mode: 0o644 },
    { name: 'read-only', bytes: Buffer.alloc(KEY_BYTES, 0x14), mode: 0o400 }
  ]
  for (const fixture of cases) {
    await withTemporaryRoot(async root => {
      const diagnostics: ProviderIsolationDiagnostic[] = []
      const keyPath = await prepareExistingKey(root, fixture.bytes, fixture.mode)
      const before = await lstat(keyPath)

      await assertUnavailable(boundStateSourceFor(root, 0x55, diagnostics))

      const after = await lstat(keyPath)
      assert.equal(after.dev, before.dev, fixture.name)
      assert.equal(after.ino, before.ino, fixture.name)
      assert.equal(after.mode & 0o777, fixture.mode, fixture.name)
      assert.deepEqual(await readFile(keyPath), fixture.bytes, fixture.name)
      assert.deepEqual(diagnostics, [{
        event: 'groupmate.provider_isolation.failure',
        code: 'secret_unavailable'
      }])
      assert.doesNotMatch(
        JSON.stringify(diagnostics),
        /bot-private|group-private|provider-isolation\.key|ENOENT|EACCES|gm_[gu]_/u
      )
    })
  }
})

test('foreign-owner validation rejects an otherwise valid key without mutation', async () => {
  await withTemporaryRoot(async root => {
    const keyPath = await prepareExistingKey(root, Buffer.alloc(KEY_BYTES, 0x22))
    const before = await lstat(keyPath)
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : before.uid

    await assertUnavailable(boundStateSourceFor(root, 0x55, [], currentUid + 1))

    const after = await lstat(keyPath)
    assert.equal(after.ino, before.ino)
    assert.equal(after.mode & 0o777, 0o600)
    assert.deepEqual(await readFile(keyPath), Buffer.alloc(KEY_BYTES, 0x22))
  })
})

test('symlink, directory and FIFO final entries fail closed without blocking', async () => {
  await withTemporaryRoot(async root => {
    const external = path.join(root, 'external.key')
    await writeFile(external, Buffer.alloc(KEY_BYTES, 0x66), { mode: 0o600 })
    const directory = path.join(root, 'data', 'identity')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const keyPath = path.join(directory, 'provider-isolation.key')
    await symlink(external, keyPath)

    await assertUnavailable(boundStateSourceFor(root, 0x77))
    assert.deepEqual(await readFile(external), Buffer.alloc(KEY_BYTES, 0x66))
    assert.equal((await lstat(keyPath)).isSymbolicLink(), true)
  })

  await withTemporaryRoot(async root => {
    const directory = path.join(root, 'data', 'identity')
    await mkdir(path.join(directory, 'provider-isolation.key'), { recursive: true })
    await chmod(directory, 0o700)
    await assertUnavailable(boundStateSourceFor(root, 0x77))
  })

  await withTemporaryRoot(async root => {
    const directory = path.join(root, 'data', 'identity')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const keyPath = path.join(directory, 'provider-isolation.key')
    await execFileAsync('mkfifo', [keyPath])
    const resolution = boundStateSourceFor(root, 0x77).resolve(groupAddress())
    const state = await Promise.race([
      resolution,
      new Promise<'timeout'>(resolve => setTimeout(() => { resolve('timeout') }, 500))
    ])
    assert.notEqual(state, 'timeout')
    assert.deepEqual(state, { kind: 'unavailable', code: 'secret_unavailable' })
    const reader = await open(keyPath, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      assert.equal((await reader.read(Buffer.alloc(1), 0, 1, null)).bytesRead, 0)
    } finally {
      await reader.close()
    }
  })

})

boundFileSystemTest('a regular file in the data ancestor fails closed without mutation', async () => {
  await withTemporaryRoot(async root => {
    await writeFile(path.join(root, 'data'), 'ancestor file', { mode: 0o600 })
    await assertUnavailable(sourceFor(root, 0x77))
    assert.equal(await readFile(path.join(root, 'data'), 'utf8'), 'ancestor file')
  })
})

boundFileSystemTest('identity directory symlinks and insecure modes are rejected without repair', async () => {
  await withTemporaryRoot(async root => {
    const external = path.join(root, 'external')
    await mkdir(path.join(root, 'data'), { recursive: true })
    await mkdir(external, { mode: 0o700 })
    await symlink(external, path.join(root, 'data', 'identity'), 'dir')

    await assertUnavailable(sourceFor(root, 0x23))

    assert.deepEqual(await readdir(external), [])
  })

  await withTemporaryRoot(async root => {
    const directory = path.join(root, 'data', 'identity')
    await mkdir(directory, { recursive: true, mode: 0o755 })
    await chmod(directory, 0o755)

    await assertUnavailable(sourceFor(root, 0x23))

    assert.equal((await lstat(directory)).mode & 0o777, 0o755)
    assert.deepEqual(await readdir(directory), [])
  })
})

boundFileSystemTest('a symlink in the data ancestor never redirects key creation', async () => {
  await withTemporaryRoot(async root => {
    const external = path.join(root, 'external-data')
    await mkdir(external, { mode: 0o700 })
    await symlink(external, path.join(root, 'data'), 'dir')

    await assertUnavailable(sourceFor(root, 0x34))

    assert.deepEqual(await readdir(external), [])
    assert.equal((await lstat(path.join(root, 'data'))).isSymbolicLink(), true)
  })
})

test('a Unix socket at the final path is rejected without connecting or blocking', async () => {
  await withTemporaryRoot(async root => {
    const directory = path.join(root, 'data', 'identity')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const keyPath = path.join(directory, 'provider-isolation.key')
    const server = createServer()
    server.listen(keyPath)
    await once(server, 'listening')
    try {
      const state = await Promise.race([
        boundStateSourceFor(root, 0x45).resolve(groupAddress()),
        new Promise<'timeout'>(resolve => setTimeout(() => { resolve('timeout') }, 500))
      ])
      assert.notEqual(state, 'timeout')
      assert.deepEqual(state, { kind: 'unavailable', code: 'secret_unavailable' })
      assert.equal((await lstat(keyPath)).isSocket(), true)
    } finally {
      server.close()
      await once(server, 'close')
    }
  })
})

test('a device node at the final path is rejected when the platform permits a fixture', async t => {
  await withTemporaryRoot(async root => {
    const directory = path.join(root, 'data', 'identity')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const keyPath = path.join(directory, 'provider-isolation.key')
    try {
      await execFileAsync('mknod', [keyPath, 'c', '1', '3'])
    } catch {
      t.skip('unprivileged platform cannot create a disposable device-node fixture')
      return
    }

    await assertUnavailable(boundStateSourceFor(root, 0x56))
    const details = await lstat(keyPath)
    assert.equal(details.isCharacterDevice() || details.isBlockDevice(), true)
  })
})

test('short temporary-file writes are retried until all secret bytes are durable', async () => {
  await withTemporaryRoot(async root => {
    const directory = path.join(root, 'data', 'identity')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const probePath = path.join(root, 'write-prototype-probe')
    const probe = await open(
      probePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    )
    const prototype = Object.getPrototypeOf(probe) as {
      write: (...args: unknown[]) => Promise<unknown>
    }
    const originalWrite = prototype.write
    await probe.close()
    await rm(probePath, { force: true })
    let writes = 0
    prototype.write = async function (this: object, ...args: unknown[]): Promise<unknown> {
      const [buffer, offset, length, position] = args
      if (buffer instanceof Uint8Array && typeof offset === 'number' &&
        typeof length === 'number') {
        writes += 1
        return await Reflect.apply(originalWrite, this, [
          buffer,
          offset,
          Math.min(length, 5),
          position
        ])
      }
      return await Reflect.apply(originalWrite, this, args)
    }
    try {
      const state = await boundStateSourceFor(root, 0x6a).resolve(groupAddress())
      assert.equal(state.kind, 'ready')
    } finally {
      prototype.write = originalWrite
    }

    assert.ok(writes > 1)
    assert.deepEqual(
      await readFile(path.join(directory, 'provider-isolation.key')),
      Buffer.alloc(KEY_BYTES, 0x6a)
    )
  })
})

boundFileSystemTest('an ancestor replacement after directory binding cannot redirect publication', async () => {
  await withTemporaryRoot(async root => {
    const external = path.join(root, 'external-data')
    mkdirSync(external, { mode: 0o700 })
    let replaced = false
    const source = createProviderIsolationIdSource({
      trustedRoot: root,
      directory: path.join(root, 'data', 'identity'),
      randomBytes: size => {
        renameSync(path.join(root, 'data'), path.join(root, 'data-bound'))
        symlinkSync(external, path.join(root, 'data'), 'dir')
        replaced = true
        return Buffer.alloc(size, 0x67)
      }
    })

    const state = await source.resolve(groupAddress())

    assert.equal(replaced, true)
    assert.equal(state.kind, 'ready')
    assert.deepEqual(await readdir(external), [])
    assert.equal((await lstat(path.join(root, 'data'))).isSymbolicLink(), true)
    assert.deepEqual(
      await readFile(path.join(root, 'data-bound', 'identity', 'provider-isolation.key')),
      Buffer.alloc(KEY_BYTES, 0x67)
    )
  })
})
