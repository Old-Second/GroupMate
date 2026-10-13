import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createActivityDispatch } from '../../src/runtime/activities/YunzaiActivityDispatch.js'
import { createYunzaiOutboundPortFactory } from '../../src/runtime/presentation/yunzai-outbound-port.js'
import type { GroupActivity } from '../../src/runtime/activities/ActivityStore.js'
import type { YunzaiBotLike } from '../../src/runtime/agent-service-bridge.js'
import type { ChatEntryPolicyPort } from '../../src/runtime/yunzai-chat-controller.js'

const record: GroupActivity = { schemaVersion: 1, id: 'a'.repeat(16), kind: 'reminder', botId: '10000', groupId: '9',
  ownerId: '7', requestKey: 'a'.repeat(64), createdAt: Date.UTC(2026, 9, 12), updatedAt: Date.UTC(2026, 9, 12),
  dueAt: Date.UTC(2026, 9, 12) + 10000, state: 'claimed', token: 'a'.repeat(32), leaseUntil: Date.UTC(2026, 9, 12) + 120000,
  content: '合成提醒', timeZone: 'UTC', intervalMs: 0, remaining: 1, options: [], multiple: false, votes: {} }
const signal = new AbortController().signal
function fixture (activity: GroupActivity = record) {
  const config: Record<string, unknown> = {}
  let joinedAt = Math.floor(record.createdAt / 1000) - 100
  let missing = false
  let muted = false
  let occupied = false
  let recipientJoinedAt = joinedAt
  let recipientMissing = false
  let releases = 0
  const reads: string[] = []
  const deliveries: unknown[] = []
  const blacklist: string[] = []
  const whitelist: string[] = []
  const bot = { uin: '10000', sendApi: async (action: string, params: Record<string, unknown>) => {
    assert.equal(action, 'get_group_member_info')
    assert.equal(params.no_cache, true)
    assert.equal(String(params.group_id), '9')
    reads.push(String(params.user_id))
    const recipient = String(params.user_id) === '8'
    return missing || (recipient && recipientMissing) ? null : { user_id: params.user_id, group_id: 9, role: 'member',
      join_time: recipient ? recipientJoinedAt : joinedAt }
  } } as unknown as YunzaiBotLike
  const policy = { snapshot: async () => ({ whitelist, blacklist }), isMuted: async () => muted } as unknown as ChatEntryPolicyPort
  const acquire = createActivityDispatch({ config, botPicker: { pick: async () => bot }, chatPolicy: policy,
    admission: { tryAcquire: async address => occupied ? null : { leaseId: 'test', sessionAddress: address, release: async () => { releases++ } } },
    outboundFactory: createYunzaiOutboundPortFactory({ forTarget: async target => {
      assert.deepEqual(target, { botId: '10000', scope: { kind: 'group', groupId: '9' } })
      return { dispatch: async part => { deliveries.push(part); return { message_id: '123' } }, recall: async () => undefined }
    } }) })
  return { acquire: (r = activity, s = signal) => acquire(r, s), config, blacklist, whitelist, reads, deliveries, releases: () => releases,
    setJoined: (value: number) => { joinedAt = value }, setMissing: () => { missing = true },
    setRecipientJoined: (value: number) => { recipientJoinedAt = value }, setRecipientMissing: () => { recipientMissing = true },
    setMuted: () => { muted = true }, setOccupied: () => { occupied = true } }
}
test('scheduled host adapter uses shared admission, uncached actor/bot membership and typed outbound receipts', async () => {
  const f = fixture()
  const lease = await f.acquire(record, signal)
  assert.ok(lease)
  assert.equal(await lease.authorize(signal), 'allowed')
  assert.deepEqual(f.reads, ['7', '10000'])
  assert.equal(await lease.deliver('合成提醒', signal), 'sent')
  assert.deepEqual(f.deliveries, [{ media: 'text', atoms: [{ kind: 'text', text: '合成提醒' }] }])
  await lease.release()
  assert.equal(f.releases(), 1)
})
test('scheduled notifications deliver genuine typed mentions once after uncached recipient checks', async () => {
  const f = fixture({ ...record, notifyUserIds: ['7', '8'] })
  const lease = await f.acquire()
  assert.ok(lease)
  assert.equal(await lease.deliver('不应投递', signal), 'failed_definite')
  assert.equal(await lease.authorize(signal), 'allowed')
  assert.deepEqual(f.reads, ['7', '10000', '8'])
  assert.equal(await lease.deliver('⏰ 定时提醒\n\n开会', signal), 'sent')
  assert.deepEqual(f.deliveries, [{ media: 'text', atoms: [
    { kind: 'at', target: { userId: '7' } }, { kind: 'text', text: ' ' },
    { kind: 'at', target: { userId: '8' } }, { kind: 'text', text: '\n' },
    { kind: 'text', text: '⏰ 定时提醒\n\n开会' }
  ] }])
  assert.equal(await lease.deliver('不能重放', signal), 'failed_definite')
  assert.equal(f.deliveries.length, 1)
  await lease.release()
})
test('recipient lookup failure or rejoining prevents both mention and text dispatch', async () => {
  const f = fixture({ ...record, notifyUserIds: ['8'] })
  const lease = await f.acquire()
  assert.ok(lease)
  assert.equal(await lease.authorize(signal), 'allowed')
  f.setRecipientJoined(Math.floor(record.createdAt / 1000) + 1)
  assert.equal(await lease.authorize(signal), 'revoked')
  assert.equal(await lease.deliver('开会', signal), 'failed_definite')
  f.setRecipientMissing()
  assert.equal(await lease.authorize(signal), 'unavailable')
  assert.equal(f.deliveries.length, 0)
  await lease.release()
})
test('member departure or lookup outage cannot send; rejoining does not revive an old task', async () => {
  const f = fixture()
  const lease = await f.acquire(record, signal)
  assert.ok(lease)
  f.setJoined(Math.floor(record.createdAt / 1000) + 100)
  assert.equal(await lease.authorize(signal), 'revoked')
  f.setMissing()
  assert.equal(await lease.authorize(signal), 'unavailable')
  assert.equal(f.deliveries.length, 0)
  await lease.release()
})
test('hiding the tool or a current blacklist revokes dispatch; group/user whitelist retains existing semantics', async () => {
  const f = fixture()
  const lease = await f.acquire(record, signal)
  assert.ok(lease)
  f.config.disabledTools = ['scheduledTask']
  assert.equal(await lease.authorize(signal), 'revoked')
  f.config.disabledTools = []
  f.blacklist.push('9^7')
  assert.equal(await lease.authorize(signal), 'revoked')
  f.whitelist.push('^7')
  assert.equal(await lease.authorize(signal), 'allowed')
  await lease.release()
})
test('muting and shared admission capacity defer with zero dispatches', async () => {
  const f = fixture()
  f.setOccupied()
  assert.equal(await f.acquire(record, signal), null)
  const g = fixture()
  g.setMuted()
  const lease = await g.acquire(record, signal)
  assert.ok(lease)
  assert.equal(await lease.authorize(signal), 'unavailable')
  assert.equal(g.reads.length, 0)
  assert.equal(g.deliveries.length, 0)
  await lease.release()
})
