import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentContentPart, AgentMessage } from '../../src/agent/contracts/content.js'
import { AgentError } from '../../src/agent/contracts/error.js'
import type { MemoryCandidate, MemoryStore } from '../../src/agent/contracts/memory.js'
import { ContextEngine } from '../../src/agent/context/context-engine.js'
import type {
  ContextInput,
  ContextItem,
  ContextSource,
  TokenEstimator
} from '../../src/agent/context/context-item.js'
import { NoopMemoryStore } from '../../src/agent/context/noop-memory-store.js'

function message (id: string, text: string, createdAt = '2026-07-13T00:00:00.000Z'): AgentMessage {
  return {
    id: `message-${id}`,
    role: 'user',
    parts: [{ type: 'text', text }],
    createdAt,
    provenance: {
      source: 'test',
      trust: 'untrusted',
      sensitivity: 'private',
      sourceId: `source-${id}`,
      createdAt
    }
  }
}

function item (
  id: string,
  source: ContextSource,
  text: string,
  atomicGroupId?: string,
  createdAt?: string
): ContextItem {
  return {
    id,
    source,
    message: message(id, text, createdAt),
    ...(atomicGroupId === undefined ? {} : { atomicGroupId })
  }
}

function input (overrides: Partial<ContextInput> = {}): ContextInput {
  return {
    systemInstructions: [item('system', 'system_instruction', 'S')],
    runtimeFacts: [],
    sessionHistory: [],
    groupContext: [],
    currentRequest: item('current', 'current_request', 'U'),
    toolMessages: [],
    ...overrides
  }
}

function budget (modelContextTokens: number) {
  return {
    modelContextTokens,
    reservedOutputTokens: 0,
    reservedToolTokens: 0,
    safetyMarginTokens: 0,
    maxItems: 20,
    maxBytes: 20_000
  }
}

const estimator: TokenEstimator = {
  estimate (value) {
    return value.parts.reduce((total: number, part: AgentContentPart) => {
      return total + (part.type === 'text' ? part.text.length : 1)
    }, 0)
  }
}

test('budget subtracts all reserves before selecting input', async () => {
  const snapshot = await new ContextEngine({
    estimator,
    memoryStore: new NoopMemoryStore()
  }).prepare(input(), {
    modelContextTokens: 10,
    reservedOutputTokens: 2,
    reservedToolTokens: 1,
    safetyMarginTokens: 1,
    maxItems: 10,
    maxBytes: 1024
  })

  assert.equal(snapshot.availableInputTokens, 6)
  assert.equal(snapshot.estimatedInputTokens, 2)
})

test('mandatory system and current items are retained or fail together', async () => {
  const engine = new ContextEngine({ estimator, memoryStore: new NoopMemoryStore() })
  const mandatoryInput = input({
    systemInstructions: [item('system', 'system_instruction', '1234')],
    currentRequest: item('current', 'current_request', '5678')
  })
  await assert.rejects(engine.prepare(mandatoryInput, budget(7)), (error: unknown) => {
    return error instanceof AgentError &&
      error.code === 'context_budget_exceeded' &&
      JSON.stringify(error.details).includes('1234') === false
  })
})

test('complete atomic groups are included or omitted together', async () => {
  const engine = new ContextEngine({ estimator, memoryStore: new NoopMemoryStore() })
  const snapshot = await engine.prepare(input({
    toolMessages: [
      item('tool-call', 'tool_chain', '1234', 'tool-group'),
      item('tool-result', 'tool_chain', '5678', 'tool-group')
    ]
  }), {
    modelContextTokens: 10,
    reservedOutputTokens: 2,
    reservedToolTokens: 1,
    safetyMarginTokens: 1,
    maxItems: 10,
    maxBytes: 1024
  })

  assert.deepEqual(snapshot.includedIds, ['system', 'current'])
  assert.deepEqual(snapshot.omitted.map(value => value.id), ['tool-call', 'tool-result'])
})

test('stable IDs are de-duplicated before budget selection', async () => {
  const snapshot = await new ContextEngine({
    estimator,
    memoryStore: new NoopMemoryStore()
  }).prepare(input({
    runtimeFacts: [
      item('duplicate', 'runtime_fact', 'first'),
      item('duplicate', 'runtime_fact', 'second')
    ]
  }), budget(20))

  assert.equal(snapshot.items.find(value => value.id === 'duplicate')?.message.parts[0]?.type, 'text')
  assert.deepEqual(snapshot.omitted, [{ id: 'duplicate', reason: 'duplicate' }])
})

test('optional sources are selected by fixed priority as budget grows', async () => {
  const memoryCandidate: MemoryCandidate = {
    memoryId: 'memory',
    message: message('memory', 'M'),
    createdAt: '2026-07-13T00:00:00.000Z',
    confidence: 1,
    sensitivity: 'private',
    conflict: 'none'
  }
  const memoryStore: MemoryStore = {
    retrieve: async () => [memoryCandidate]
  }
  const engine = new ContextEngine({ estimator, memoryStore })
  const priorityInput = input({
    runtimeFacts: [item('runtime', 'runtime_fact', 'R')],
    sessionHistory: [item('session', 'session_history', 'H')],
    groupContext: [item('group', 'group_context', 'G')],
    toolMessages: [item('tool', 'tool_chain', 'T')],
    memoryQuery: {
      botId: '10000',
      namespace: { kind: 'personal', userId: '7' },
      requester: { userId: '7', role: 'member' },
      limit: 1,
      maxTokens: 1
    }
  })
  const expected = [
    ['system', 'runtime', 'current'],
    ['system', 'runtime', 'current', 'tool'],
    ['system', 'runtime', 'session', 'current', 'tool'],
    ['system', 'runtime', 'session', 'group', 'current', 'tool'],
    ['system', 'runtime', 'session', 'group', 'memory:memory', 'current', 'tool']
  ]

  for (let optionalCount = 1; optionalCount <= 5; optionalCount += 1) {
    const snapshot = await engine.prepare(priorityInput, budget(2 + optionalCount))
    assert.deepEqual(snapshot.includedIds, expected[optionalCount - 1])
  }
})

test('selected items return in stable semantic order', async () => {
  const snapshot = await new ContextEngine({
    estimator,
    memoryStore: new NoopMemoryStore()
  }).prepare(input({
    systemInstructions: [item('system-2', 'system_instruction', 'S2')],
    runtimeFacts: [item('runtime', 'runtime_fact', 'R')],
    sessionHistory: [item('session', 'session_history', 'H')],
    groupContext: [item('group', 'group_context', 'G')],
    currentRequest: item('current', 'current_request', 'U'),
    toolMessages: [item('tool', 'tool_chain', 'T')]
  }), budget(20))

  assert.deepEqual(snapshot.includedIds, [
    'system-2', 'runtime', 'session', 'group', 'current', 'tool'
  ])
})

test('maxItems and maxBytes reject input before token estimation', async () => {
  let estimates = 0
  const countingEstimator: TokenEstimator = {
    estimate (value) {
      estimates += 1
      return estimator.estimate(value)
    }
  }
  const engine = new ContextEngine({
    estimator: countingEstimator,
    memoryStore: new NoopMemoryStore()
  })
  await assert.rejects(engine.prepare(input(), {
    ...budget(20),
    maxItems: 1
  }), (error: unknown) => error instanceof AgentError && error.code === 'context_budget_exceeded')
  await assert.rejects(engine.prepare(input(), {
    ...budget(20),
    maxBytes: 1
  }), (error: unknown) => error instanceof AgentError && error.code === 'context_budget_exceeded')
  assert.equal(estimates, 0)
})

test('identical inputs produce identical redacted diagnostics', async () => {
  const engine = new ContextEngine({ estimator, memoryStore: new NoopMemoryStore() })
  const contextInput = input({ groupContext: [item('private-id', 'group_context', 'secret-text')] })
  const first = await engine.prepare(contextInput, budget(2))
  const second = await engine.prepare(contextInput, budget(2))

  assert.deepEqual(first.includedIds, second.includedIds)
  assert.deepEqual(first.omitted, second.omitted)
  assert.doesNotMatch(JSON.stringify(first.omitted), /secret-text/)
})

test('NoopMemoryStore returns one frozen empty result and exposes no writer', async () => {
  const memory = new NoopMemoryStore()
  const result = await memory.retrieve({
    botId: '10000',
    namespace: { kind: 'personal', userId: '7' },
    requester: { userId: '7', role: 'member' },
    limit: 1,
    maxTokens: 1
  })
  assert.deepEqual(result, [])
  assert.equal(Object.isFrozen(result), true)
  assert.equal('save' in memory, false)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(memory.retrieve({
    botId: '10000',
    namespace: { kind: 'personal', userId: '7' },
    requester: { userId: '7', role: 'member' },
    limit: 1,
    maxTokens: 1
  }, controller.signal), (error: unknown) => {
    return error instanceof AgentError && error.code === 'cancelled'
  })
})
