import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { openGroupMemoryPolicyStoreV1 } from '../../src/runtime/GroupMemoryPolicy.js'

const SCOPE = Object.freeze({ botInstanceId: 'groupmate-production', accountId: '10001', groupId: '40004' })
const NOW = '2026-10-16T08:00:00.000Z'

function location (t: { after: (fn: () => unknown) => void }): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'groupmate-group-policy-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'group-memory-policy.sqlite')
}

test('group memory policy defaults on and stores only explicit decisions with advancing generations', t => {
  const file = location(t)
  const store = openGroupMemoryPolicyStoreV1(file)
  t.after(() => store.close())
  assert.deepEqual(store.read(SCOPE), {
    group_memory: { enabled: true, generation: 0 },
    group_culture: { enabled: true, generation: 0 }
  })
  assert.equal(store.decide(SCOPE, 'group_memory', true, 'actor:a', NOW).status, 'unchanged')
  const closed = store.decide(SCOPE, 'group_memory', false, 'actor:a', NOW)
  assert.equal(closed.status, 'stored')
  assert.deepEqual(closed.policy.group_memory, { enabled: false, generation: 1 })
  assert.deepEqual(closed.policy.group_culture, { enabled: true, generation: 0 })
  assert.deepEqual(store.decide(SCOPE, 'group_memory', true, 'actor:a', NOW).policy.group_memory,
    { enabled: true, generation: 2 })
  assert.deepEqual(store.read({ ...SCOPE, groupId: '50005' }).group_memory, { enabled: true, generation: 0 })
  assert.deepEqual(store.read({ ...SCOPE, accountId: '10002' }).group_memory, { enabled: true, generation: 0 })
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('group memory policy decisions survive reopen and reject invalid scopes or foreign files', t => {
  const file = location(t)
  const first = openGroupMemoryPolicyStoreV1(file)
  first.decide(SCOPE, 'group_culture', false, 'actor:a', NOW)
  first.close()
  const reopened = openGroupMemoryPolicyStoreV1(file)
  t.after(() => reopened.close())
  assert.deepEqual(reopened.read(SCOPE).group_culture, { enabled: false, generation: 1 })
  for (const scope of [{ ...SCOPE, groupId: '0' }, { ...SCOPE, accountId: 'x' }, { ...SCOPE, botInstanceId: '' }]) {
    assert.throws(() => reopened.read(scope), TypeError)
  }
  assert.throws(() => reopened.decide(SCOPE, 'unknown' as never, false, 'actor:a', NOW), TypeError)

  const foreign = location(t)
  const database = new DatabaseSync(foreign)
  database.exec('CREATE TABLE other(id INTEGER)')
  database.close()
  assert.throws(() => openGroupMemoryPolicyStoreV1(foreign), TypeError)
  const untouched = new DatabaseSync(foreign, { readOnly: true })
  try {
    assert.equal(untouched.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'group_memory_policies'").get()?.n, 0)
  } finally { untouched.close() }
})
