import assert from 'node:assert/strict'
import { test } from 'node:test'

const stored = new Map()
globalThis.redis = {
  get: async key => stored.get(key) ?? null,
  set: async (key, value) => { stored.set(key, value) }
}

const { AddUser, GetUser, UserInfo, ReplaceUsers } = await import('../../server/modules/user_data.js')

async function reset (users = []) {
  stored.set('CHATGPT:SERVER_USER', JSON.stringify({ user: users }))
  await ReplaceUsers()
}

function persisted () {
  return JSON.parse(stored.get('CHATGPT:SERVER_USER')).user
}

test('a repeated login keeps one record per account and follows the fresh authority', async () => {
  await reset()

  await AddUser({ user: '10001', token: 'token-admin', autho: 'admin' })
  await AddUser({ user: 10001, token: 'token-user', autho: 'user' })

  const records = persisted()
  assert.equal(records.length, 1)
  assert.deepEqual(records[0].token, ['token-admin', 'token-user'])
  assert.equal(records[0].autho, 'user')
  assert.equal(UserInfo('token-admin')?.autho, 'user')
  assert.equal(UserInfo('token-user')?.autho, 'user')
})

test('a replayed token is not stored twice and an unrelated label survives the login', async () => {
  await reset([{ user: '10001', autho: 'user', token: ['token-user'], label: '备注', tiem: 0 }])

  await AddUser({ user: '10001', token: 'token-user', autho: 'user' })

  assert.deepEqual(persisted()[0].token, ['token-user'])
  assert.equal(persisted()[0].label, '备注')
  assert.equal(UserInfo('token-user')?.label, '备注')
})

test('a user lookup matches the requested account only', async () => {
  await reset([
    { user: '10001', autho: 'admin', token: ['token-admin'], label: '', tiem: 0 },
    { user: '10002', autho: 'user', token: ['token-user'], label: '', tiem: 0 }
  ])

  assert.equal(GetUser(10002)?.autho, 'user')
  assert.equal(GetUser('10001')?.autho, 'admin')
  assert.equal(GetUser('10003'), undefined)
  assert.equal(UserInfo('token-unknown'), undefined)
})
