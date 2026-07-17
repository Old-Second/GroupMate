import assert from 'node:assert/strict'
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { GroupMateDiskLog } from '../../src/runtime/logging/groupmate-disk-log.js'

const FIXED_TIMESTAMP = '2026-07-17T08:09:10.000Z'

async function logFiles (directory: string): Promise<readonly string[]> {
  return (await readdir(directory))
    .filter(name => /^groupmate-\d{4}-\d{2}-\d{2}\.\d{4}\.jsonl$/.test(name))
    .sort()
}

async function readLogRows (directory: string): Promise<readonly Record<string, unknown>[]> {
  const files = await logFiles(directory)
  const rows: Record<string, unknown>[] = []
  for (const file of files) {
    const content = await readFile(path.join(directory, file), 'utf8')
    rows.push(...content.trimEnd().split('\n').map(line => JSON.parse(line)))
  }
  return rows
}

test('writes complete ordered JSONL envelopes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'groupmate-disk-log-'))
  try {
    const log = new GroupMateDiskLog({
      directory,
      now: () => new Date(FIXED_TIMESTAMP)
    })
    log.record({ type: 'fixture', payload: { text: '完整正文' } })
    log.record({ type: 'fixture', payload: { text: '第二条' } })

    await log.drain()

    const files = await logFiles(directory)
    assert.deepEqual(files, ['groupmate-2026-07-17.0001.jsonl'])
    const content = await readFile(path.join(directory, files[0] as string), 'utf8')
    const lines = content.trimEnd().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(lines, [
      {
        schemaVersion: 1,
        sequence: 1,
        recordedAt: FIXED_TIMESTAMP,
        event: { type: 'fixture', payload: { text: '完整正文' } }
      },
      {
        schemaVersion: 1,
        sequence: 2,
        recordedAt: FIXED_TIMESTAMP,
        event: { type: 'fixture', payload: { text: '第二条' } }
      }
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('rotates a local-date file before an append crosses the file limit', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'groupmate-disk-log-'))
  try {
    const log = new GroupMateDiskLog({
      directory,
      now: () => new Date(FIXED_TIMESTAMP),
      limits: { maxFileBytes: 180 }
    })
    log.record({ type: 'fixture', payload: { text: '甲'.repeat(20) } })
    log.record({ type: 'fixture', payload: { text: '乙'.repeat(20) } })

    await log.drain()

    assert.deepEqual(await logFiles(directory), [
      'groupmate-2026-07-17.0001.jsonl',
      'groupmate-2026-07-17.0002.jsonl'
    ])
    assert.deepEqual((await readLogRows(directory)).map(row => row.sequence), [1, 2])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('removes expired matching files on the first write without touching other files', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'groupmate-disk-log-'))
  try {
    await writeFile(path.join(directory, 'groupmate-2026-07-14.0001.jsonl'), 'expired\n')
    await writeFile(path.join(directory, 'groupmate-2026-07-16.0001.jsonl'), 'retained\n')
    await writeFile(path.join(directory, 'unrelated.txt'), 'preserve\n')
    const log = new GroupMateDiskLog({
      directory,
      now: () => new Date('2026-07-17T12:00:00.000Z'),
      limits: { retentionMs: 2 * 24 * 60 * 60 * 1_000 }
    })

    log.record({ type: 'fixture', payload: { text: 'current' } })
    await log.drain()

    assert.deepEqual(await logFiles(directory), [
      'groupmate-2026-07-16.0001.jsonl',
      'groupmate-2026-07-17.0001.jsonl'
    ])
    assert.equal(await readFile(path.join(directory, 'unrelated.txt'), 'utf8'), 'preserve\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('prunes oldest inactive matching files for the projected directory cap', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'groupmate-disk-log-'))
  try {
    await writeFile(path.join(directory, 'groupmate-2026-07-15.0001.jsonl'), 'a'.repeat(220))
    await writeFile(path.join(directory, 'groupmate-2026-07-16.0001.jsonl'), 'b'.repeat(220))
    await writeFile(path.join(directory, 'unrelated.txt'), 'preserve\n')
    const log = new GroupMateDiskLog({
      directory,
      now: () => new Date(FIXED_TIMESTAMP),
      limits: {
        retentionMs: 10 * 24 * 60 * 60 * 1_000,
        maxDirectoryBytes: 500
      }
    })

    log.record({ type: 'fixture', payload: { text: 'current' } })
    await log.drain()

    assert.deepEqual(await logFiles(directory), [
      'groupmate-2026-07-16.0001.jsonl',
      'groupmate-2026-07-17.0001.jsonl'
    ])
    assert.equal(await readFile(path.join(directory, 'unrelated.txt'), 'utf8'), 'preserve\n')
    const files = await logFiles(directory)
    const bytes = (await Promise.all(files.map(async file => (
      await stat(path.join(directory, file))).size))).reduce((total, size) => total + size, 0)
    assert.ok(bytes <= 500)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('globally rate limits failure callbacks while allowing the next callback at one minute', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'groupmate-disk-log-'))
  try {
    let now = new Date(FIXED_TIMESTAMP)
    const failures: unknown[] = []
    const log = new GroupMateDiskLog({
      directory,
      now: () => now,
      limits: { maxQueueRecords: 2, maxQueueBytes: 600, maxEntryBytes: 300 },
      onFailure: failure => { failures.push(failure) }
    })
    log.record({ type: 'fixture', payload: { text: 'first' } })
    log.record({ type: 'fixture', payload: { text: 'second' } })
    log.record({ type: 'fixture', payload: { text: 'third' } })
    log.record({ type: 'fixture', payload: { text: 'oversized'.repeat(100) } })

    await log.drain()

    now = new Date(now.getTime() + 59_999)
    log.record({ type: 'fixture', payload: { text: 'oversized'.repeat(100) } })
    now = new Date(now.getTime() + 1)
    log.record({ type: 'fixture', payload: { text: 'oversized'.repeat(100) } })

    assert.deepEqual((await readLogRows(directory)).map(row => row.sequence), [1, 2])
    assert.deepEqual(failures, [
      { event: 'groupmate.disk_log.failure', code: 'queue_overflow' },
      { event: 'groupmate.disk_log.failure', code: 'entry_too_large' }
    ])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('tightens an existing log directory and target file before appending', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'groupmate-disk-log-'))
  const target = path.join(directory, 'groupmate-2026-07-17.0001.jsonl')
  try {
    await chmod(directory, 0o755)
    await writeFile(target, 'existing\n')
    await chmod(target, 0o644)
    const log = new GroupMateDiskLog({
      directory,
      now: () => new Date(FIXED_TIMESTAMP)
    })

    log.record({ type: 'fixture', payload: { text: 'current' } })
    await assert.doesNotReject(log.drain())

    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal((await stat(target)).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('never follows a matching log-file symlink to an unrelated file', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'groupmate-disk-log-'))
  const directory = path.join(root, 'logs')
  const victim = path.join(root, 'victim.txt')
  const target = path.join(directory, 'groupmate-2026-07-17.0001.jsonl')
  try {
    await mkdir(directory)
    await writeFile(victim, 'victim bytes\n')
    await chmod(victim, 0o644)
    await symlink(victim, target)
    const before = await readFile(victim, 'utf8')
    const beforeMode = (await stat(victim)).mode & 0o777
    const failures: unknown[] = []
    const log = new GroupMateDiskLog({
      directory,
      now: () => new Date(FIXED_TIMESTAMP),
      onFailure: failure => { failures.push(failure) }
    })

    log.record({ type: 'fixture', payload: { text: 'current' } })
    await assert.doesNotReject(log.drain())

    assert.equal(await readFile(victim, 'utf8'), before)
    assert.equal((await stat(victim)).mode & 0o777, beforeMode)
    assert.equal((await lstat(target)).isSymbolicLink(), true)
    assert.deepEqual(failures, [
      { event: 'groupmate.disk_log.failure', code: 'write_failed' }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a configured log-directory symlink without changing its target', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'groupmate-disk-log-'))
  const targetDirectory = path.join(root, 'target-directory')
  const directory = path.join(root, 'log-directory')
  const victim = path.join(targetDirectory, 'victim.txt')
  try {
    await mkdir(targetDirectory)
    await chmod(targetDirectory, 0o755)
    await writeFile(victim, 'victim bytes\n')
    await symlink(targetDirectory, directory, 'dir')
    const before = await readFile(victim, 'utf8')
    const beforeMode = (await stat(targetDirectory)).mode & 0o777
    const failures: unknown[] = []
    const log = new GroupMateDiskLog({
      directory,
      now: () => new Date(FIXED_TIMESTAMP),
      onFailure: failure => { failures.push(failure) }
    })

    log.record({ type: 'fixture', payload: { text: 'current' } })
    await assert.doesNotReject(log.drain())

    assert.equal(await readFile(victim, 'utf8'), before)
    assert.equal((await stat(targetDirectory)).mode & 0o777, beforeMode)
    assert.equal((await lstat(directory)).isSymbolicLink(), true)
    assert.deepEqual(await readdir(targetDirectory), ['victim.txt'])
    assert.deepEqual(failures, [
      { event: 'groupmate.disk_log.failure', code: 'write_failed' }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('isolates write failures and reports fixed metadata no more than once per minute', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'groupmate-disk-log-'))
  const directory = path.join(root, 'not-a-directory')
  try {
    await writeFile(directory, 'file\n')
    let now = new Date(FIXED_TIMESTAMP)
    const failures: unknown[] = []
    const log = new GroupMateDiskLog({
      directory,
      now: () => now,
      onFailure: failure => {
        failures.push(failure)
        throw new Error('callback failure must be isolated')
      }
    })
    log.record({ type: 'fixture', payload: { text: 'first' } })
    log.record({ type: 'fixture', payload: { text: 'second' } })
    await assert.doesNotReject(log.drain())

    now = new Date(now.getTime() + 60_000)
    log.record({ type: 'fixture', payload: { text: 'third' } })
    await assert.doesNotReject(log.drain())

    assert.deepEqual(failures, [
      { event: 'groupmate.disk_log.failure', code: 'write_failed' },
      { event: 'groupmate.disk_log.failure', code: 'write_failed' }
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
