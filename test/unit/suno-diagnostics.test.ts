import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { recordSunoDiagnostic } from '../../src/runtime/SunoDiagnostics.js'

test('Suno token, account, error, retry and heartbeat logs project only bounded diagnostics', async () => {
  const entries: unknown[] = []
  const logger = { debug: (entry: unknown) => entries.push(entry) }
  for (const operation of ['token', 'create', 'poll', 'account', 'credit', 'heartbeat', 'generate'] as const) {
    for (const outcome of ['success', 'failure', 'retry', 'insufficient_credit'] as const) {
      recordSunoDiagnostic(logger, operation, outcome, 401)
    }
  }
  const sentinel = 'SYNTHETIC_SECRET_SESSION_ACCOUNT'
  recordSunoDiagnostic(logger, 'token', 'success', sentinel as unknown as number)
  recordSunoDiagnostic(logger, sentinel as 'token', 'success')
  recordSunoDiagnostic(logger, 'poll', sentinel as 'success')
  assert.equal(entries.length, 29)
  assert.ok(!JSON.stringify(entries).includes(sentinel))
  for (const entry of entries as Record<string, unknown>[]) {
    assert.ok(Object.keys(entry).every(key => ['event', 'operation', 'outcome', 'status'].includes(key)))
  }
  assert.doesNotThrow(() => recordSunoDiagnostic({ debug: () => { throw new Error(sentinel) } }, 'token', 'success'))
  for (const file of ['client/SunoClient.js', 'apps/vocal.js']) {
    const source = await readFile(path.resolve(file), 'utf8')
    assert.doesNotMatch(source, /console\.(log|error)|logger\.(debug|info|warn|error)/)
  }
})

test('Suno fake response paths retain songs, credit and heartbeat without leaking raw payloads', async () => {
  const source = await readFile(path.resolve('client/SunoClient.js'), 'utf8')
  const logs: unknown[] = []
  const sentinel = 'SYNTHETIC_SESSION_TOKEN_ACCOUNT_ERROR'
  let requests: Array<{ status: number; body: unknown }> = []
  const fetch = async () => {
    const next = requests.shift()
    assert.ok(next)
    return { status: next.status, json: async () => next.body, text: async () => sentinel }
  }
  // Exercise the legacy host shell with injected transports, without a Yunzai checkout or network.
  const compiled = source.replace(/^import .*\n/gm, '').replace('export class SunoClient', 'class SunoClient')
  const Client = new Function('newFetch', 'common', 'decrypt', 'recordSunoDiagnostic', 'logger', 'fetch', `${compiled}\nreturn SunoClient`)(
    fetch, { sleep: async () => {} }, () => JSON.stringify({ sid: sentinel }), recordSunoDiagnostic,
    { debug: (entry: unknown) => logs.push(entry) }, fetch
  )
  const client = new Client({ sessToken: sentinel, clientToken: sentinel })
  requests = [{ status: 200, body: { jwt: sentinel } }, { status: 200, body: { clips: [{ id: 'a' }, { id: 'b' }] } },
    { status: 401, body: sentinel }, { status: 200, body: { jwt: sentinel } },
    { status: 200, body: [{ id: 'a', status: 'complete', title: sentinel }, { id: 'b', status: 'error' }] }]
  assert.deepEqual(await client.createSong('synthetic prompt'), [{ id: 'a', status: 'complete', title: sentinel }])
  requests = [{ status: 200, body: { jwt: sentinel } }, { status: 200, body: { total_credits_left: 12, raw: sentinel } }, { status: 200, body: { user: { email: sentinel } } }]
  assert.deepEqual(await client.queryCredit(), { credit: 12, email: sentinel })
  requests = [{ status: 200, body: sentinel }]
  assert.equal(await client.heartbeat(), true)
  requests = [{ status: 200, body: { jwt: sentinel } }, { status: 503, body: sentinel }]
  await assert.rejects(client.createSong('synthetic prompt'), /Failed to create song 503/)
  assert.ok(!JSON.stringify(logs).includes(sentinel))
})
