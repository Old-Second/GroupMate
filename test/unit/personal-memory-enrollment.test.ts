import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1
} from '../../src/agent/memory/memory-access-gate.js'
import { createMemorySourceV1 } from '../../src/agent/memory/memory-domain.js'
import {
  createMemoryLifecycleAuthorityRootV1,
  issueMemoryLifecycleActorCapabilityV1
} from '../../src/agent/memory/memory-lifecycle-authority.js'
import {
  createPersonalMemoryEnrollmentCommandV1,
  createPersonalMemoryEnrollmentPolicyV1,
  createPersonalMemoryEnrollmentPortV1,
  decodePersonalMemoryEnrollmentPolicyV1,
  encodePersonalMemoryEnrollmentPolicyV1
} from '../../src/agent/memory/personal-memory-enrollment.js'
import {
  createMemoryNamespaceV1,
  memoryNamespaceRefV1,
  type MemoryNamespaceV1
} from '../../src/agent/memory/memory-namespace.js'
import { openSqliteMemoryDatabaseV3 } from '../../src/agent/memory/sqlite-memory-database.js'
import {
  createSqlitePersonalMemoryEnrollmentAdapterV1
} from '../../src/agent/memory/sqlite-personal-memory-enrollment.js'
import {
  FIXTURE_IDS,
  personalMemoryNamespaceFixture
} from '../helpers/memory-fixture.js'

const NOW = '2026-07-25T08:00:00.000Z'
const LATER = '2026-07-25T08:00:01.000Z'
const FUTURE = '2026-07-25T08:02:00.000Z'
const ACTOR_REF = `actor:${'a'.repeat(64)}`

function commandRef (digit: string): string {
  return `command:${digit.repeat(64)}`
}

function privateSource (
  observedAt = NOW,
  userId: string = FIXTURE_IDS.subjectUserId
) {
  return createMemorySourceV1({
    sourceKind: 'current_message',
    messageId: 'message:personal-memory-enrollment',
    actor: {
      userId,
      nickname: '爱丽丝',
      groupCard: null,
      groupTitle: null,
      groupRole: 'unknown',
      displayName: '爱丽丝'
    },
    scene: {
      kind: 'private',
      groupId: null,
      groupLifecycleId: null,
      groupName: null
    },
    observedAt,
    normalizedText: '开启个人长期记忆',
    resourceRefs: []
  })
}

function authority (
  namespace: MemoryNamespaceV1,
  now = NOW
) {
  const context = {
    schemaVersion: 1 as const,
    botInstanceId: namespace.botInstanceId,
    adapter: 'qq' as const,
    accountId: namespace.accountId,
    scene: {
      kind: 'private' as const,
      peerUserId: namespace.scope.kind === 'personal'
        ? namespace.scope.subjectUserId
        : FIXTURE_IDS.subjectUserId
    }
  }
  const access = issueMemoryAccessCapabilityV1(
    createMemoryAccessCapabilityIssuerV1(() => true),
    context,
    [namespace],
    now
  )
  const actor = issueMemoryLifecycleActorCapabilityV1(
    createMemoryLifecycleAuthorityRootV1(() => true),
    {
      schemaVersion: 1,
      botInstanceId: namespace.botInstanceId,
      adapter: 'qq',
      accountId: namespace.accountId,
      sceneRef: access.sceneRef,
      namespace,
      namespaceRef: memoryNamespaceRefV1(namespace),
      generation: 1,
      actorRef: ACTOR_REF,
    actorUserId: namespace.scope.kind === 'personal'
      ? namespace.scope.subjectUserId
      : FIXTURE_IDS.subjectUserId,
      role: 'personal_subject',
      roleObservedAt: null,
      actions: ['manage_enrollment']
    },
    now
  )
  return { access, actor }
}

function enrollmentCommand (
  namespace: MemoryNamespaceV1,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  return createPersonalMemoryEnrollmentCommandV1({
    commandRef: commandRef('1'),
    operation: 'enrollment.optIn',
    initiatedByActorRef: ACTOR_REF,
    namespaceRef: memoryNamespaceRefV1(namespace),
    expectedNamespaceGeneration: 1,
    expectedPolicyGeneration: 0,
    candidateMode: 'off',
    occurredAt: NOW,
    source: privateSource(
      NOW,
      namespace.scope.kind === 'personal'
        ? namespace.scope.subjectUserId
        : FIXTURE_IDS.subjectUserId
    ),
    ...overrides
  })
}

function envelope (
  namespace: MemoryNamespaceV1,
  overrides: Readonly<Record<string, unknown>> = {}
) {
  const auth = authority(namespace)
  return {
    schemaVersion: 1 as const,
    namespace,
    command: enrollmentCommand(namespace),
    access: auth.access,
    actor: auth.actor,
    ...overrides
  }
}

function harness (t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'groupmate-personal-enrollment-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const location = join(directory, 'memory.sqlite')
  let currentNow = NOW
  const store = openSqliteMemoryDatabaseV3({
    location,
    now: () => currentNow,
    manifests: []
  })
  const adapter = createSqlitePersonalMemoryEnrollmentAdapterV1({
    database: store.database,
    now: () => currentNow
  })
  const port = createPersonalMemoryEnrollmentPortV1({
    now: () => currentNow,
    read: adapter.read,
    decide: adapter.decide
  })
  return {
    location,
    store,
    port,
    setNow: (value: string) => { currentNow = value }
  }
}

test('personal enrollment policy codec is canonical and bounded', () => {
  const namespace = personalMemoryNamespaceFixture()
  const value = createPersonalMemoryEnrollmentPolicyV1({
    schemaVersion: 1 as const,
    namespaceRef: memoryNamespaceRefV1(namespace),
    namespaceGeneration: 1,
    state: 'opted_in' as const,
    candidateMode: 'shadow' as const,
    policyGeneration: 2,
    commandRefHash: 'a'.repeat(64),
    commandHash: 'b'.repeat(64),
    decidedByActorRefHash: 'c'.repeat(64),
    decisionSourceRefHash: 'd'.repeat(64),
    updatedAt: NOW
  })
  const wire = encodePersonalMemoryEnrollmentPolicyV1(value)
  assert.deepEqual(decodePersonalMemoryEnrollmentPolicyV1(wire), value)
  assert.throws(() => decodePersonalMemoryEnrollmentPolicyV1(`${wire} `), TypeError)
  assert.throws(() => encodePersonalMemoryEnrollmentPolicyV1({
    ...value,
    state: 'opted_out',
    candidateMode: 'shadow'
  }), TypeError)
  assert.throws(() => encodePersonalMemoryEnrollmentPolicyV1(new Proxy(value, {})), TypeError)
})

test('personal enrollment port binds current-message source, subject actor and exact capabilities', async () => {
  const namespace = personalMemoryNamespaceFixture()
  const accepted = envelope(namespace)
  const options = {
    now: () => NOW,
    read: async () => ({ status: 'not_enrolled' }),
    decide: async () => ({ status: 'stored', policy: {
      schemaVersion: 1,
      namespaceRef: memoryNamespaceRefV1(namespace),
      namespaceGeneration: 1,
      state: 'opted_in',
      candidateMode: 'off',
      policyGeneration: 1,
      commandRefHash: 'a'.repeat(64),
      commandHash: 'b'.repeat(64),
      decidedByActorRefHash: 'c'.repeat(64),
      decisionSourceRefHash: 'd'.repeat(64),
      updatedAt: NOW,
      policyHash: 'e'.repeat(64)
    } })
  }
  const rejecting = createPersonalMemoryEnrollmentPortV1(options)
  assert.equal((await rejecting.decide({
    ...accepted,
    access: { ...accepted.access }
  })).status, 'denied')
  assert.equal((await rejecting.decide({
    ...accepted,
    actor: { ...accepted.actor }
  })).status, 'denied')
  assert.throws(() => rejecting.decide({
    ...accepted,
    command: enrollmentCommand(namespace, {
      source: privateSource(LATER)
    })
  }), TypeError)
  const otherSource = createMemorySourceV1({
      sourceKind: 'current_message',
      messageId: 'message:other-user',
      actor: {
        userId: FIXTURE_IDS.secondUserId,
        nickname: null,
        groupCard: null,
        groupTitle: null,
        groupRole: 'unknown',
        displayName: FIXTURE_IDS.secondUserId
      },
      scene: {
        kind: 'private',
        groupId: null,
        groupLifecycleId: null,
        groupName: null
      },
      observedAt: NOW,
      normalizedText: '开启个人长期记忆',
      resourceRefs: []
    })
  await assert.rejects(rejecting.decide({
    ...accepted,
    command: enrollmentCommand(namespace, { source: otherSource })
  }), TypeError)
})

test('personal enrollment read rechecks cancellation and access after dispatch', async () => {
  const namespace = personalMemoryNamespaceFixture()
  const auth = authority(namespace)
  const request = { schemaVersion: 1 as const, namespace, access: auth.access }
  const times = [NOW, FUTURE]
  const expired = createPersonalMemoryEnrollmentPortV1({
    now: () => times.shift() ?? FUTURE,
    read: async () => ({ status: 'not_enrolled' }),
    decide: async () => ({ status: 'aborted' })
  })
  assert.deepEqual(await expired.read(request), { status: 'denied' })

  const controller = new AbortController()
  const cancelled = createPersonalMemoryEnrollmentPortV1({
    now: () => NOW,
    read: async () => {
      controller.abort()
      return { status: 'not_enrolled' }
    },
    decide: async () => ({ status: 'aborted' })
  })
  assert.deepEqual(await cancelled.read(request, controller.signal), { status: 'aborted' })
})

test('sqlite enrollment does not create state for a first opt-out', async t => {
  const namespace = personalMemoryNamespaceFixture()
  const state = harness(t)
  const request = envelope(namespace, {
    command: enrollmentCommand(namespace, {
      operation: 'enrollment.optOut',
      candidateMode: 'off'
    })
  })
  assert.deepEqual(await state.port.decide(request), {
    status: 'conflict',
    category: 'generation'
  })
  assert.equal(state.store.database.prepare('SELECT count(*) AS count FROM namespaces').get()?.count, 0)
  assert.equal(state.store.database.prepare(
    'SELECT count(*) AS count FROM personal_memory_policies'
  ).get()?.count, 0)
})

test('sqlite enrollment creates an empty namespace and exact replay survives restart', async t => {
  const namespace = personalMemoryNamespaceFixture()
  const first = harness(t)
  const request = envelope(namespace)
  const stored = await first.port.decide(request)
  assert.equal(stored.status, 'stored')
  if (stored.status !== 'stored') return
  assert.equal(stored.policy.policyGeneration, 1)
  assert.deepEqual({ ...first.store.database.prepare(`
    SELECT namespace_records, active_memory_records, canonical_logical_bytes
    FROM global_usage WHERE singleton = 1
  `).get() }, {
    namespace_records: 1,
    active_memory_records: 0,
    canonical_logical_bytes: first.store.database.prepare(`
      SELECT namespace_wire_bytes AS bytes FROM namespaces WHERE namespace_ref = ?
    `).get(memoryNamespaceRefV1(namespace))?.bytes
  })
  assert.equal(first.store.database.prepare('SELECT count(*) AS count FROM usage').get()?.count, 1)
  assert.equal(first.store.database.prepare(
    'SELECT count(*) AS count FROM lifecycle_namespace_usage'
  ).get()?.count, 1)
  assert.equal((await first.port.decide(request)).status, 'unchanged')
  first.store.close()

  let currentNow = NOW
  const reopened = openSqliteMemoryDatabaseV3({
    location: first.location,
    now: () => currentNow,
    manifests: []
  })
  t.after(reopened.close)
  const adapter = createSqlitePersonalMemoryEnrollmentAdapterV1({
    database: reopened.database,
    now: () => currentNow
  })
  const port = createPersonalMemoryEnrollmentPortV1({
    now: () => currentNow,
    read: adapter.read,
    decide: adapter.decide
  })
  assert.equal((await port.decide(request)).status, 'unchanged')
  const read = await port.read({
    schemaVersion: 1,
    namespace,
    access: authority(namespace).access
  })
  assert.equal(read.status, 'found')
  if (read.status === 'found') assert.equal(read.policy.state, 'opted_in')

  currentNow = LATER
  const optOut = envelope(namespace, {
    command: enrollmentCommand(namespace, {
      commandRef: commandRef('2'),
      operation: 'enrollment.optOut',
      expectedPolicyGeneration: 1,
      candidateMode: 'off',
      occurredAt: LATER,
      source: privateSource(LATER)
    }),
    ...authority(namespace, LATER)
  })
  const optedOut = await port.decide(optOut)
  assert.equal(optedOut.status, 'stored')
  if (optedOut.status === 'stored') {
    assert.equal(optedOut.policy.state, 'opted_out')
    assert.equal(optedOut.policy.policyGeneration, 2)
  }
  assert.equal(reopened.database.prepare('SELECT count(*) AS count FROM namespaces').get()?.count, 1)
  assert.equal(reopened.database.prepare('SELECT count(*) AS count FROM heads').get()?.count, 0)
  assert.equal((await port.decide(request)).status, 'conflict')
})

test('sqlite enrollment uses CAS across handles and fails closed on policy tamper', async t => {
  const first = harness(t)
  const namespace = personalMemoryNamespaceFixture()
  assert.equal((await first.port.decide(envelope(namespace))).status, 'stored')

  const secondStore = openSqliteMemoryDatabaseV3({
    location: first.location,
    now: () => LATER,
    manifests: []
  })
  t.after(secondStore.close)
  const secondAdapter = createSqlitePersonalMemoryEnrollmentAdapterV1({
    database: secondStore.database,
    now: () => LATER
  })
  const secondPort = createPersonalMemoryEnrollmentPortV1({
    now: () => LATER,
    read: secondAdapter.read,
    decide: secondAdapter.decide
  })
  const next = envelope(namespace, {
    command: enrollmentCommand(namespace, {
      commandRef: commandRef('3'),
      expectedPolicyGeneration: 1,
      candidateMode: 'shadow',
      occurredAt: LATER,
      source: privateSource(LATER)
    }),
    ...authority(namespace, LATER)
  })
  const results = await Promise.all([
    secondPort.decide(next),
    secondPort.decide({
      ...next,
      command: enrollmentCommand(namespace, {
        commandRef: commandRef('4'),
        expectedPolicyGeneration: 1,
        candidateMode: 'policy_approved',
        occurredAt: LATER,
        source: privateSource(LATER)
      })
    })
  ])
  assert.deepEqual(results.map(result => result.status).sort(), ['conflict', 'stored'])

  secondStore.database.prepare(`
    UPDATE personal_memory_policies SET policy_wire = '{}', policy_wire_bytes = 2
    WHERE namespace_ref = ?
  `).run(memoryNamespaceRefV1(namespace))
  const read = await secondPort.read({
    schemaVersion: 1,
    namespace,
    access: authority(namespace, LATER).access
  })
  assert.deepEqual(read, { status: 'corrupt', category: 'canonical_data' })
})

test('sqlite enrollment rejects undercounted global namespace usage', async t => {
  const state = harness(t)
  const first = personalMemoryNamespaceFixture()
  assert.equal((await state.port.decide(envelope(first))).status, 'stored')
  state.store.database.prepare(`
    UPDATE global_usage SET namespace_records = 0, canonical_logical_bytes = 0
    WHERE singleton = 1
  `).run()

  const second = createMemoryNamespaceV1({
    botInstanceId: first.botInstanceId,
    adapter: 'qq',
    accountId: first.accountId,
    scope: { kind: 'personal', subjectUserId: FIXTURE_IDS.secondUserId }
  })
  const secondRequest = envelope(second, {
    command: enrollmentCommand(second, {
      source: privateSource(NOW, FIXTURE_IDS.secondUserId)
    })
  })
  assert.deepEqual(await state.port.decide(secondRequest), {
    status: 'corrupt',
    category: 'canonical_data'
  })
  assert.equal(state.store.database.prepare('SELECT count(*) AS count FROM namespaces').get()?.count, 1)
})

test('sqlite enrollment persists trusted time and rejects rollback-era authority', async t => {
  const state = harness(t)
  const namespace = personalMemoryNamespaceFixture()
  assert.equal((await state.port.decide(envelope(namespace))).status, 'stored')

  state.setNow(FUTURE)
  const futureDecision = envelope(namespace, {
    command: enrollmentCommand(namespace, {
      commandRef: commandRef('5'),
      operation: 'enrollment.optOut',
      expectedPolicyGeneration: 1,
      candidateMode: 'off',
      occurredAt: FUTURE,
      source: privateSource(FUTURE)
    }),
    ...authority(namespace, FUTURE)
  })
  assert.equal((await state.port.decide(futureDecision)).status, 'stored')

  state.setNow(NOW)
  const rollbackDecision = envelope(namespace, {
    command: enrollmentCommand(namespace, {
      commandRef: commandRef('6'),
      expectedPolicyGeneration: 2,
      occurredAt: NOW,
      source: privateSource(NOW)
    }),
    ...authority(namespace, NOW)
  })
  assert.deepEqual(await state.port.decide(rollbackDecision), {
    status: 'denied',
    category: 'authority'
  })
  assert.deepEqual({ ...state.store.database.prepare(`
    SELECT state, policy_generation, updated_at_ms
    FROM personal_memory_policies WHERE namespace_ref = ?
  `).get(memoryNamespaceRefV1(namespace)) }, {
    state: 'opted_out',
    policy_generation: 2,
    updated_at_ms: Date.parse(FUTURE)
  })
})
