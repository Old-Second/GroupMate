import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import {
  createMemoryExtractionJobV1,
  deriveMemoryCandidateProvenanceV1
} from '../../src/agent/memory/memory-candidate-pipeline.js'
import {
  createMemoryCandidateLifecycleSinkV1
} from '../../src/agent/memory/memory-candidate-lifecycle-sink.js'
import {
  createMemoryLifecycleAuthorityRootV1,
  issueMemoryLifecycleActorCapabilityV1,
  issueMemoryPolicyCapabilityV1
} from '../../src/agent/memory/memory-lifecycle-authority.js'
import { createMemoryLifecyclePortV1 } from '../../src/agent/memory/memory-lifecycle-port.js'
import { memoryNamespaceRefV1 } from '../../src/agent/memory/memory-namespace.js'
import { openSqliteMemoryDatabaseV3 } from '../../src/agent/memory/sqlite-memory-database.js'
import { createSqliteMemoryLifecycleAdapterV1 } from '../../src/agent/memory/sqlite-memory-lifecycle.js'
import {
  FIXTURE_IDS,
  FIXTURE_TIMES,
  memorySourceFixture,
  personalMemoryNamespaceFixture,
  qqIdentityFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-07-19T00:03:00.000Z'

function privateSceneRef (): string {
  const namespace = personalMemoryNamespaceFixture()
  return issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: namespace.botInstanceId,
      adapter: 'qq',
      accountId: namespace.accountId,
      scene: { kind: 'private', peerUserId: FIXTURE_IDS.subjectUserId }
    },
    [namespace],
    NOW
  ).sceneRef
}

function submission (approvalMode: 'shadow' | 'policy_approved') {
  const namespace = personalMemoryNamespaceFixture()
  const job = createMemoryExtractionJobV1({
    namespace,
    namespaceGeneration: 1,
    subject: qqIdentityFixture(),
    source: memorySourceFixture(),
    sceneRef: privateSceneRef(),
    sourceRunRef: FIXTURE_IDS.runRef,
    sourceModelProfile: 'deepseek-chat',
    requestedMode: approvalMode === 'shadow' ? 'shadow' : 'automatic',
    priority: 'inferred',
    enqueuedAt: FIXTURE_TIMES.proposedAt,
    assistantReply: '好，我记下了。'
  })
  const candidate = Object.freeze({
    kind: 'preference' as const,
    text: '喜欢无糖咖啡',
    sourceIds: Object.freeze([job.source.sourceId]),
    derivation: 'stated' as const,
    confidence: 0.91,
    sensitivity: 'personal' as const
  })
  return Object.freeze({
    schemaVersion: 1 as const,
    job,
    candidate,
    provenance: deriveMemoryCandidateProvenanceV1(job, candidate),
    conflict: Object.freeze({
      state: 'none' as const,
      relatedMemoryIds: Object.freeze([]),
      note: null
    }),
    extractorVersion: 'candidate-v1',
    extractorModelProfile: 'deepseek-chat',
    approvalMode,
    submittedAt: NOW
  })
}

function fixture () {
  const namespace = personalMemoryNamespaceFixture()
  const namespaceRef = memoryNamespaceRefV1(namespace)
  const store = openSqliteMemoryDatabaseV3({ location: ':memory:', now: () => NOW, manifests: [] })
  const adapter = createSqliteMemoryLifecycleAdapterV1({ database: store.database, now: () => NOW })
  const lifecycle = createMemoryLifecyclePortV1({ now: () => NOW, execute: adapter.execute })
  const accessIssuer = createMemoryAccessCapabilityIssuerV1(() => true)
  const authorityRoot = createMemoryLifecycleAuthorityRootV1(() => true)
  const sink = createMemoryCandidateLifecycleSinkV1({
    lifecycle,
    authorize: async input => {
      const access = issueMemoryAccessCapabilityV1(accessIssuer, {
        schemaVersion: 1,
        botInstanceId: namespace.botInstanceId,
        adapter: 'qq',
        accountId: namespace.accountId,
        scene: { kind: 'private', peerUserId: FIXTURE_IDS.subjectUserId }
      }, [namespace], NOW)
      const actor = issueMemoryLifecycleActorCapabilityV1(authorityRoot, {
        schemaVersion: 1,
        botInstanceId: namespace.botInstanceId,
        adapter: 'qq',
        accountId: namespace.accountId,
        sceneRef: access.sceneRef,
        namespace,
        namespaceRef,
        generation: 1,
        actorRef: FIXTURE_IDS.actorRef,
        actorUserId: FIXTURE_IDS.subjectUserId,
        role: 'personal_subject',
        roleObservedAt: null,
        actions: ['propose_create']
      }, NOW)
      const policy = input.approvalMode === 'policy_approved'
        ? issueMemoryPolicyCapabilityV1(authorityRoot, {
            schemaVersion: 1,
            botInstanceId: namespace.botInstanceId,
            adapter: 'qq',
            accountId: namespace.accountId,
            sceneRef: access.sceneRef,
            namespace,
            namespaceRef,
            generation: 1,
            policyRef: FIXTURE_IDS.policyRef,
            policyGeneration: 1,
            createdByActorRef: FIXTURE_IDS.actorRef,
            createdByUserId: FIXTURE_IDS.subjectUserId,
            consent: 'owner_policy',
            allowedKinds: ['preference'],
            allowedSensitivities: ['personal'],
            allowedSourceKinds: ['current_message'],
            allowedRetentionPolicyRefs: ['retention:memory-lifecycle-v1']
          }, NOW)
        : null
      return { status: 'authorized', access, actor, policy }
    }
  })
  return Object.freeze({ store, sink })
}

test('lifecycle candidate sink stores shadow as a pending model proposal only', async () => {
  const current = fixture()
  try {
    const result = await current.sink.submit(submission('shadow'))
    assert.equal(result.status, 'stored')
    assert.equal(result.outcome, 'shadow')
    const row = current.store.database.prepare(`
      SELECT state, proposal_wire FROM proposals
    `).get()
    assert.equal(row?.state, 'pending')
    const proposal = JSON.parse(String(row?.proposal_wire)) as Record<string, unknown>
    assert.deepEqual(proposal.proposedBy, {
      kind: 'model', runRef: FIXTURE_IDS.runRef, modelProfile: 'deepseek-chat'
    })
    assert.equal(proposal.consentRequirement, 'explicit')
  } finally {
    current.store.close()
  }
})

test('automatic candidate uses separate actor proposal and owner-policy approval commands', async () => {
  const current = fixture()
  try {
    const result = await current.sink.submit(submission('policy_approved'))
    assert.equal(result.status, 'stored')
    assert.equal(result.outcome, 'approved')
    const proposal = current.store.database.prepare(`
      SELECT state, resulting_memory_id FROM proposals
    `).get()
    assert.equal(proposal?.state, 'approved')
    assert.equal(typeof proposal?.resulting_memory_id, 'string')
    assert.equal(current.store.database.prepare(
      'SELECT count(*) AS count FROM heads'
    ).get()?.count, 1)
    assert.equal(current.store.database.prepare(
      'SELECT count(*) AS count FROM lifecycle_commands'
    ).get()?.count, 2)
  } finally {
    current.store.close()
  }
})

test('authorization denial performs zero lifecycle mutation', async () => {
  const current = fixture()
  try {
    const denied = createMemoryCandidateLifecycleSinkV1({
      lifecycle: { execute: async () => { throw new Error('must not dispatch') } },
      authorize: async () => ({ status: 'denied', reason: 'policy' })
    })
    assert.deepEqual(await denied.submit(submission('shadow')), {
      status: 'denied', reason: 'policy'
    })
  } finally {
    current.store.close()
  }
})

test('lifecycle sink rejects malformed submissions before authorization or mutation', async () => {
  let authorizationCalls = 0
  let lifecycleCalls = 0
  const sink = createMemoryCandidateLifecycleSinkV1({
    lifecycle: {
      execute: async () => {
        lifecycleCalls += 1
        throw new Error('must not dispatch')
      }
    },
    authorize: async () => {
      authorizationCalls += 1
      return { status: 'denied', reason: 'policy' }
    }
  })
  const valid = submission('shadow')
  const malformed = {
    ...valid,
    provenance: { ...valid.provenance, speakerRelation: 'self', injected: true }
  }

  assert.deepEqual(await sink.submit(malformed as never), {
    status: 'unavailable', retryable: false
  })
  assert.equal(authorizationCalls, 0)
  assert.equal(lifecycleCalls, 0)

  let toJsonCalls = 0
  const hostileProvenance = {
    ...valid.provenance,
    toJSON () {
      toJsonCalls += 1
      return valid.provenance
    }
  }
  assert.deepEqual(await sink.submit({
    ...valid,
    provenance: hostileProvenance
  } as never), {
    status: 'unavailable', retryable: false
  })
  assert.equal(toJsonCalls, 0)
  assert.equal(authorizationCalls, 0)
  assert.equal(lifecycleCalls, 0)
})

test('lifecycle sink independently rejects direct automatic-approval escalation', async () => {
  let authorizationCalls = 0
  const sink = createMemoryCandidateLifecycleSinkV1({
    lifecycle: { execute: async () => { throw new Error('must not dispatch') } },
    authorize: async () => {
      authorizationCalls += 1
      return { status: 'denied', reason: 'policy' }
    }
  })
  const shadow = submission('shadow')
  const escalated = Object.freeze({ ...shadow, approvalMode: 'policy_approved' as const })

  assert.deepEqual(await sink.submit(escalated), {
    status: 'denied', reason: 'policy'
  })
  assert.equal(authorizationCalls, 0)
})
