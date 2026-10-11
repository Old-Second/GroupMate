import { runScheduledGreetings } from '../../src/runtime/ScheduledGreeting.js'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { projectYunzaiParticipation } from '../../src/runtime/participation/YunzaiParticipationAdapter.js'
import { ParticipationShadow } from '../../src/runtime/participation/ParticipationShadow.js'
import { createGroupMateContentJournal } from '../../src/runtime/logging/groupmate-content-journal.js'
import { normalizeGuobaConfigValue } from '../../src/runtime/guoba-config.js'

const input = { event: { isGroup: true, self_id: 'bot', user_id: 'actor', group_id: 'group', message_id: 'message', msg: '哈哈', message: [{ type: 'text', text: '@bot' }] }, botId: 'bot', now: 1_000, explicitlyAddressed: false, eligible: true }

test('host evidence isolates bot/group/actor and never treats quoted text or fake at as direct', () => {
  const projected = projectYunzaiParticipation(input)!
  assert.equal(projected.addressed, false)
  assert.equal(projected.acknowledgement, true)
  assert.notEqual(projected.scopeRef, projectYunzaiParticipation({ ...input, botId: 'another-bot' })!.scopeRef)
  assert.notEqual(projected.scopeRef, projectYunzaiParticipation({ ...input, event: { ...input.event, group_id: 'another-group' } })!.scopeRef)
  assert.equal(projectYunzaiParticipation({ ...input, event: { ...input.event, user_id: 'bot' } }), null)
  assert.equal(projectYunzaiParticipation({ ...input, event: { ...input.event, message_id: undefined } }), null)
  assert.ok(projectYunzaiParticipation({ ...input, event: { ...input.event, message_id: -12345 } }))
  const at = projectYunzaiParticipation({ ...input, event: { ...input.event, message: [{ type: 'at', qq: 'bot' }] } })!
  assert.equal(at.addressed, true)
})

test('legacy scheduled greetings retain group lists, interval and probability independently of shadow', async () => {
  const source = await readFile('apps/entertainment.js', 'utf8')
  assert.match(source, /7-23\/' \+ Config\.helloInterval/)
  const start = source.indexOf('  async sendRandomMessage () {')
  const end = source.indexOf('  async ', start + 10)
  assert.ok(start >= 0 && end > start)
  const method = source.slice(start, end)
  const sent: Array<{ group: number; text: string }> = []
  const bot = { gl: new Map([[123, {}]]), nickname: 'synthetic' }
  const config = { debug: false, initiativeChatGroups: ['', '123', '456'], helloProbability: 25, defaultUseTTS: false }
  let generations = 0
  let sample = 0.24
  const task = new Function('Config', 'Math', 'logger', 'listYunzaiBots', 'generateHello', 'sendScheduledGroupMessage', 'runScheduledGreetings', 'getProductionYunzaiAgent',
    `return ({${method}}).sendRandomMessage`)(config, { floor: Math.floor, random: () => sample },
    { info: () => {}, warn: () => {} }, () => [bot], async () => { generations++; return 'synthetic greeting' },
    async (_: unknown, group: number, text: string) => { sent.push({ group, text }) },
    (ports: Parameters<typeof runScheduledGreetings>[0]) => runScheduledGreetings({ ...ports, random: () => sample }),
    () => ({ claimScheduledGreeting: async () => ({ current: () => true, finish: async () => {} }) }))
  await task.call({})
  assert.deepEqual(sent, [{ group: 123, text: 'synthetic greeting' }])
  assert.equal(generations, 1)
  sample = 0.25
  await task.call({})
  assert.equal(sent.length, 1)
})

test('shadow only projects bounded statistics and tolerates journal errors', async () => {
  const entries: unknown[] = []
  const journal = createGroupMateContentJournal({ record: event => { entries.push(event) }, drain: async () => {} })
  const shadow = new ParticipationShadow(() => 1_000, entry => journal.recordParticipation!(entry))
  assert.equal(shadow.compare(projectYunzaiParticipation(input)!, true), null)
  assert.deepEqual((entries[0] as any).payload, { schemaVersion: 1, policyVersion: 1, legacyAllowed: true,
    proposedAllowed: false, reason: 'acknowledgement', disagreement: true, scopes: 1, candidates: 0, stateBytes: shadow.state.stats().bytes })
  assert.doesNotMatch(JSON.stringify(entries), /actor|group|bot|message|哈哈/)
  journal.recordParticipation!({ ...(entries[0] as any).payload, token: 'secret' })
  assert.equal((entries[1] as any).type, 'groupmate.content_journal.projection_failure')
  const throwing = new ParticipationShadow(() => 1_000, () => { throw new Error('log') })
  assert.ok(throwing.compare(projectYunzaiParticipation({ ...input, explicitlyAddressed: true })!, true))
  shadow.close()
  assert.equal(shadow.state.stats().scopes, 0)
  assert.equal(normalizeGuobaConfigValue('participationMode', 'shadow'), 'shadow')
  assert.throws(() => normalizeGuobaConfigValue('participationMode', 'active'))
  // This component has no authority ports and cannot start extra model or business work.
  const source = await readFile('src/runtime/participation/ParticipationShadow.ts', 'utf8')
  assert.doesNotMatch(source, /import.*(?:model|tools|memory|outbound|agent-service)/)
})
