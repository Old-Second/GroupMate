import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentContentPart, AgentMessage } from '../../src/agent/contracts/content.js'
import { ContextEngine } from '../../src/agent/context/context-engine.js'
import type {
  ContextInput,
  ContextItem,
  ContextSource,
  TokenEstimator
} from '../../src/agent/context/context-item.js'
import {
  PHASE_7D_CANDIDATE_CORPUS,
  PHASE_7D_DELETION_CARRIERS,
  PHASE_7D_RETRIEVAL_CORPUS,
  evaluatePhase7dCandidateCorpus,
  evaluatePhase7dDeletionCorpus,
  evaluatePhase7dRetrievalCorpus
} from '../../src/verification/phase-7d-memory-scenario.js'

function message (id: string, text: string): AgentMessage {
  return Object.freeze({
    id: `message-${id}`,
    role: 'user' as const,
    parts: Object.freeze([{ type: 'text' as const, text }]),
    createdAt: '2026-07-25T00:00:00.000Z',
    provenance: Object.freeze({
      source: 'phase7d-test',
      trust: 'untrusted' as const,
      sensitivity: 'private' as const,
      sourceId: `source-${id}`,
      createdAt: '2026-07-25T00:00:00.000Z'
    })
  })
}

function item (id: string, source: ContextSource, text: string): ContextItem {
  return Object.freeze({ id, source, message: message(id, text) })
}

function memoryItem (id: string, text: string): ContextItem {
  const revisionHash = 'a'.repeat(64)
  const base = item(id, 'memory', text)
  return Object.freeze({
    ...base,
    message: Object.freeze({
      ...base.message,
      provenance: Object.freeze({
        ...base.message.provenance,
        sourceId: `memory:${revisionHash}`
      })
    }),
    memoryRecord: Object.freeze({
      memoryId: `memory:${'b'.repeat(64)}`,
      revision: 1,
      revisionHash,
      namespaceRef: 'c'.repeat(64)
    })
  })
}

const estimator: TokenEstimator = Object.freeze({
  estimate (value: AgentMessage): number {
    return value.parts.reduce((total: number, part: AgentContentPart) => (
      total + (part.type === 'text' ? part.text.length : 1)
    ), 0)
  }
})

function contextInput (): ContextInput {
  return Object.freeze({
    systemInstructions: Object.freeze([item('system', 'system_instruction', 'system')]),
    runtimeFacts: Object.freeze([item('runtime', 'runtime_fact', 'runtime')]),
    sessionHistory: Object.freeze([item('history', 'session_history', 'history')]),
    groupContext: Object.freeze([item('group', 'group_context', 'group')]),
    memoryContext: Object.freeze([memoryItem('memory', 'dynamic memory')]),
    currentRequest: item('current', 'current_request', 'current'),
    toolMessages: Object.freeze([])
  })
}

test('Phase 7D freezes a QQ-like retrieval corpus with zero unrelated-user leakage', () => {
  assert.deepEqual(PHASE_7D_RETRIEVAL_CORPUS.map(value => value.caseId), [
    'private_current_exact',
    'same_user_cross_group_fts',
    'group_current_actor_fts',
    'group_quoted_present_fts',
    'group_mentioned_present_exact',
    'group_unrelated_user_denied',
    'group_departed_user_denied',
    'other_group_proof_denied',
    'ambiguous_target_denied'
  ])
  const report = evaluatePhase7dRetrievalCorpus(PHASE_7D_RETRIEVAL_CORPUS.map(value => ({
    caseId: value.caseId,
    expectedRelevant: value.expectedRelevant,
    observedRelevant: value.expectedRelevant,
    observedUnrelated: 0,
    denied: value.expectedDenied
  })))
  assert.deepEqual(report, {
    caseCount: 9,
    positiveCaseCount: 5,
    deniedCaseCount: 4,
    expectedRelevant: 5,
    observedRelevant: 5,
    observedUnrelated: 0,
    recallPermille: 1_000,
    leakageCount: 0,
    passed: true
  })

  assert.equal(evaluatePhase7dRetrievalCorpus(PHASE_7D_RETRIEVAL_CORPUS.map(value => ({
    caseId: value.caseId,
    expectedRelevant: value.expectedRelevant,
    observedRelevant: value.caseId === 'group_current_actor_fts' ? 0 : value.expectedRelevant,
    observedUnrelated: value.caseId === 'group_unrelated_user_denied' ? 1 : 0,
    denied: value.expectedDenied
  }))).passed, false)
})

test('Phase 7D shadow corpus requires perfect admitted precision and fixed secret rejection', () => {
  assert.deepEqual(PHASE_7D_CANDIDATE_CORPUS.map(value => value.caseId), [
    'stated_preference_shadow',
    'third_party_inference_shadow_only',
    'possible_conflict_shadow_only',
    'credential_api_key_rejected',
    'credential_cookie_rejected',
    'credential_verification_code_rejected',
    'low_value_ack_rejected',
    'duplicate_rejected'
  ])
  const report = evaluatePhase7dCandidateCorpus(PHASE_7D_CANDIDATE_CORPUS.map(value => ({
    caseId: value.caseId,
    outcome: value.expectedOutcome,
    provenancePreserved: true,
    conflictPreserved: true
  })))
  assert.deepEqual(report, {
    caseCount: 8,
    expectedAdmitted: 3,
    observedAdmitted: 3,
    falsePositiveCount: 0,
    credentialRejected: 3,
    lowValueRejected: 1,
    duplicateRejected: 1,
    precisionPermille: 1_000,
    passed: true
  })
  assert.equal(evaluatePhase7dCandidateCorpus(PHASE_7D_CANDIDATE_CORPUS.map(value => ({
    caseId: value.caseId,
    outcome: value.caseId === 'credential_api_key_rejected'
      ? 'shadow_stored'
      : value.expectedOutcome,
    provenancePreserved: true,
    conflictPreserved: true
  }))).passed, false)
})

test('Phase 7D deletion corpus rejects resurrection from every derived carrier', () => {
  assert.deepEqual(PHASE_7D_DELETION_CARRIERS, [
    'canonical', 'fts', 'cache', 'queue', 'context'
  ])
  assert.deepEqual(evaluatePhase7dDeletionCorpus({
    canonical: 0,
    fts: 0,
    cache: 0,
    queue: 0,
    context: 0
  }), {
    residualRecords: 0,
    passed: true
  })
  assert.equal(evaluatePhase7dDeletionCorpus({
    canonical: 0,
    fts: 1,
    cache: 0,
    queue: 0,
    context: 0
  }).passed, false)
})

test('dynamic memory follows the stable prefix and cannot displace mandatory context', async () => {
  const engine = new ContextEngine({ estimator })
  const spans = engine.projectSourceSpans(contextInput(), 'run:phase7d-context')
  assert.deepEqual(spans.map(span => span.source), [
    'system_instruction',
    'runtime_fact',
    'session_history',
    'group_context',
    'memory',
    'current_request'
  ])
  assert.equal(spans.find(value => value.source === 'memory')?.trust, 'untrusted')
  assert.equal(spans.find(value => value.source === 'memory')?.requirement, 'optional')

  const snapshot = await engine.prepare(contextInput(), {
    modelContextTokens: 13,
    reservedOutputTokens: 0,
    reservedToolTokens: 0,
    safetyMarginTokens: 0,
    maxItems: 16,
    maxBytes: 16 * 1_024
  })
  assert.equal(snapshot.includedIds.includes('system'), true)
  assert.equal(snapshot.includedIds.includes('current'), true)
  assert.equal(snapshot.includedIds.includes('memory'), false)
})
