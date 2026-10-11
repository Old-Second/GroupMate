import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runScheduledGreetings } from '../../src/runtime/ScheduledGreeting.js'
import { ProactiveCoordination } from '../../src/runtime/participation/ProactiveCoordination.js'

test('overlapping cron callbacks generate and send one greeting per bot/group while preserving probability', async () => {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  let calls = 0
  const sent: unknown[] = []
  const ports = { groups: ['9', '9'], probability: 25, bots: [{ uin: '1', gl: new Map([[9, {}]]) }],
    random: () => 0.24, generate: async () => { calls++; await pending; return 'hello' },
    render: async (text: string) => text, send: async (...args: unknown[]) => { sent.push(args) } }
  const first = runScheduledGreetings(ports)
  await runScheduledGreetings(ports)
  release()
  await first
  assert.equal(calls, 1)
  assert.equal(sent.length, 1)
  await runScheduledGreetings({ ...ports, random: () => 0.25 })
  assert.equal(sent.length, 1)
  assert.equal(await runScheduledGreetings({ ...ports, render: async () => null }), false)
})

test('cron and BYM share a thirty second cross-source cooldown; direct requests invalidate a pending cron', async () => {
  let time = 1_000
  const gate = new ProactiveCoordination(() => time)
  const cron = gate.begin('bot', 'group', 'cron')!
  assert.equal(gate.begin('bot', 'group', 'bym'), null)
  const direct = gate.begin('bot', 'group', 'bym', true)!
  assert.equal(cron.current(), false)
  await cron.finish(true)
  await direct.finish(true)
  assert.equal(gate.begin('bot', 'group', 'cron'), null)
  time += 30_000
  const next = gate.begin('bot', 'group', 'cron')!
  await next.finish(true)
  assert.equal(gate.begin('bot', 'group', 'bym'), null)
  assert.ok(gate.begin('bot', 'group', 'bym', true))
})

test('a cron lease invalidated while generating has zero late deliveries and releases once', async () => {
  let current = true
  let sends = 0
  const finishes: boolean[] = []
  await runScheduledGreetings({ groups: ['9'], probability: 100, bots: [{ uin: '1', gl: new Map([[9, {}]]) }],
    claim: async () => ({ current: () => current, finish: async sent => { finishes.push(sent) } }),
    generate: async () => { current = false; return 'stale' }, render: async text => text,
    send: async () => { sends++; return true } })
  assert.equal(sends, 0)
  assert.deepEqual(finishes, [false])
})
