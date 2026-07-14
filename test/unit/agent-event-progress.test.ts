import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentEvent, AgentEventType } from '../../src/agent/contracts/event.js'
import { RunProgressPresenter } from '../../src/runtime/run-progress-presenter.js'

function event (
  sequence: number,
  type: AgentEventType,
  payload: AgentEvent['payload'] = {}
): AgentEvent {
  return Object.freeze({
    eventVersion: 1,
    eventId: `event-${sequence}`,
    runId: 'run-private-value',
    sessionId: 'session-private-value',
    sequence,
    occurredAt: `2026-07-14T01:00:${String(sequence).padStart(2, '0')}.000Z`,
    type,
    payload: Object.freeze(payload)
  })
}

test('progress presenter sends deterministic bounded tool milestones at most five times', async () => {
  const sent: string[] = []
  const presenter = new RunProgressPresenter()
  presenter.attach('run-private-value', async text => { sent.push(text) })

  const names = ['website', 'weather', 'github', 'queryUserinfo', 'sendPicture', 'musicQuery']
  names.forEach((toolName, index) => presenter.handle(event(index, 'tool.started', { toolName })))
  await presenter.drain('run-private-value')

  assert.deepEqual(sent.slice(0, 2), ['正在读取网页', '正在查询天气'])
  assert.equal(sent.length, 5)
  assert.equal(sent.every(text => [...text.normalize('NFC').trim()].length <= 200), true)
})

test('progress presenter deduplicates persisted events and suppresses terminal late delivery', async () => {
  const sent: string[] = []
  const presenter = new RunProgressPresenter()
  const historical = event(0, 'tool.started', { toolName: 'website' })
  presenter.attach('run-private-value', async text => { sent.push(text) }, [historical])

  presenter.handle(historical)
  presenter.handle(event(1, 'tool.started', { toolName: 'website' }))
  presenter.handle(event(2, 'run.completed', { visibleOutput: false }))
  presenter.handle(event(3, 'tool.started', { toolName: 'weather' }))
  await presenter.drain('run-private-value')

  assert.deepEqual(sent, [])
})

test('progress presenter ignores model-like text and isolates delivery failures', async () => {
  const logs: unknown[] = []
  const sent: string[] = []
  let attempts = 0
  const presenter = new RunProgressPresenter({
    onDeliveryFailure: value => logs.push(value)
  })
  presenter.attach('run-private-value', async text => {
    attempts += 1
    if (attempts === 1) throw new Error('private delivery body')
    sent.push(text)
  })

  presenter.handle(event(0, 'run.progress', {
    stage: 'tool_started', toolName: 'website', text: 'model supplied private progress'
  }))
  presenter.handle(event(1, 'tool.started', { toolName: 'weather' }))
  await presenter.drain('run-private-value')

  assert.deepEqual(sent, ['正在查询天气'])
  assert.equal(attempts, 2)
  assert.doesNotMatch(JSON.stringify(logs), /private delivery body|model supplied/)
})
