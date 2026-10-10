import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryOutboxPortV1 } from '../../src/agent/memory/memory-outbox.js'
import { memoryNamespaceRefV1, parseMemoryNamespaceV1 } from '../../src/agent/memory/memory-namespace.js'
import { memoryOutboxEventFixture, personalMemoryNamespaceFixture } from '../helpers/memory-fixture.js'

test('namespace deletion outbox claims reject other namespaces, generations and event kinds', async () => {
  const namespaceRef = memoryNamespaceRefV1(personalMemoryNamespaceFixture())
  const otherRef = memoryNamespaceRefV1(parseMemoryNamespaceV1({ ...personalMemoryNamespaceFixture(),
    scope: { kind: 'personal', subjectUserId: '99999' }
  }))
  const matching = memoryOutboxEventFixture({ namespaceRef, namespaceGeneration: 2,
    aggregate: 'namespace', aggregateId: namespaceRef, revision: 2, eventKind: 'namespace_deleted' })
  const request = { schemaVersion: 1, operation: 'claim_namespace_deletion', ownerId: 'deletion-test',
    namespaceRef, namespaceGeneration: 2, limit: 32 }
  for (const event of [matching,
    memoryOutboxEventFixture({ namespaceRef: otherRef, namespaceGeneration: 2,
      aggregate: 'namespace', aggregateId: otherRef, revision: 2, eventKind: 'namespace_deleted' }),
    memoryOutboxEventFixture({ namespaceRef, namespaceGeneration: 3,
      aggregate: 'namespace', aggregateId: namespaceRef, revision: 3, eventKind: 'namespace_deleted' }),
    memoryOutboxEventFixture({ namespaceRef, namespaceGeneration: 2 })]) {
    const port = createMemoryOutboxPortV1({ now: () => '2026-07-19T00:05:00.000Z',
      execute: async () => ({ status: 'claimed', ownerId: request.ownerId,
        leaseToken: `memory-lease:v1:${'a'.repeat(64)}`, leasedUntil: '2026-07-19T00:06:00.000Z', events: [event] }) })
    const result = await port.execute(request)
    if (event === matching) assert.equal(result.status, 'claimed')
    else assert.deepEqual(result, { status: 'corrupt', category: 'adapter_contract' })
  }
})
