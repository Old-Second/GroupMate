import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'

const root = process.cwd()

test('package declares the deployed Node 22.14 runtime as its exact baseline', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8')
  ) as {
    engines?: { node?: string }
    devDependencies?: Record<string, string>
  }

  assert.equal(packageJson.engines?.node, '>=22.14.0')
  assert.equal(packageJson.devDependencies?.['@types/node'], '22.14.0')
})

test('pnpm lockfile pins the same Node type baseline', async () => {
  const lockfile = await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8')

  assert.match(lockfile, /'@types\/node':\n\s+specifier: 22\.14\.0\n\s+version: 22\.14\.0/)
  assert.match(lockfile, /^  '@types\/node@22\.14\.0':$/m)
  assert.doesNotMatch(lockfile, /@types\/node@18\.19\.130/)
})

test('the declared runtime baseline exposes the node:sqlite API used by memory storage', () => {
  const database = new DatabaseSync(':memory:')
  try {
    database.exec('CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT')
    database.prepare('INSERT INTO probe(value) VALUES (?)').run('ready')
    const row = database.prepare('SELECT id, value FROM probe').get()
    assert.equal(row?.id, 1)
    assert.equal(row?.value, 'ready')
  } finally {
    database.close()
  }
})
