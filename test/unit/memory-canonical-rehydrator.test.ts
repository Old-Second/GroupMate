import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import {
  createMemoryCanonicalRehydratorV1
} from '../../src/agent/memory/memory-canonical-rehydrator.js'
import { createMemoryHeadSourcePortV1 } from '../../src/agent/memory/memory-head-reader.js'
import {
  memoryNamespaceRefV1
} from '../../src/agent/memory/memory-namespace.js'
import {
  FIXTURE_IDS,
  memoryRecordFixture,
  memoryRevisionFixture,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-07-25T00:00:00.000Z'

function fixture () {
  const namespace = personalMemoryNamespaceFixture()
  const namespaceRef = memoryNamespaceRefV1(namespace)
  const memoryId = `memory:${'a'.repeat(64)}`
  const record = memoryRecordFixture({ memoryId })
  const revision = memoryRevisionFixture({ memoryId, record })
  const capability = issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: FIXTURE_IDS.botInstanceId,
      adapter: 'qq',
      accountId: FIXTURE_IDS.accountId,
      scene: { kind: 'private', peerUserId: FIXTURE_IDS.subjectUserId }
    },
    [namespace],
    NOW
  )
  return { namespaceRef, memoryId, record, revision, capability }
}

test('canonical rehydrator closes a head race after validating revision identity and payload', async () => {
  const value = fixture()
  const originalHead = Object.freeze({
    namespaceRef: value.namespaceRef,
    namespaceGeneration: 1,
    memoryId: value.memoryId,
    revision: 1,
    contentHash: value.record.contentHash
  })
  let headReads = 0
  let identityReads = 0
  const source = createMemoryHeadSourcePortV1({
    execute: async request => {
      if (request.operation === 'head.get') {
        headReads += 1
        return headReads === 1
          ? { status: 'found', head: originalHead }
          : { status: 'not_found' }
      }
      if (request.operation === 'record.getExact') {
        return { status: 'found', record: value.record }
      }
      return { status: 'found', namespaceGeneration: 1 }
    }
  })
  const rehydrator = createMemoryCanonicalRehydratorV1({
    source,
    verifier: {
      verify: async () => {
        identityReads += 1
        return { status: 'current' }
      }
    },
    now: () => NOW
  })

  assert.deepEqual(await rehydrator.rehydrate({
    capability: value.capability,
    identity: {
      namespaceRef: value.namespaceRef,
      namespaceGeneration: 1,
      memoryId: value.memoryId,
      memoryRevision: 1,
      revisionHash: value.revision.revisionHash
    }
  }), { status: 'stale' })
  assert.equal(identityReads, 2)
  assert.equal(headReads, 2)
})

test('canonical rehydrator rejects a stale revision hash before loading a body', async () => {
  const value = fixture()
  let sourceReads = 0
  const rehydrator = createMemoryCanonicalRehydratorV1({
    source: createMemoryHeadSourcePortV1({
      execute: async () => {
        sourceReads += 1
        return { status: 'not_found' }
      }
    }),
    verifier: { verify: async () => ({ status: 'stale' }) },
    now: () => NOW
  })
  assert.deepEqual(await rehydrator.rehydrate({
    capability: value.capability,
    identity: {
      namespaceRef: value.namespaceRef,
      namespaceGeneration: 1,
      memoryId: value.memoryId,
      memoryRevision: 1,
      revisionHash: 'f'.repeat(64)
    }
  }), { status: 'stale' })
  assert.equal(sourceReads, 0)
})
