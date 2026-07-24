import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decidePersonalMemoryPilotV1,
  type PersonalMemoryPilotDecisionV1
} from '../../src/agent/memory/personal-memory-pilot-policy.js'
import { MEMORY_DERIVATIVE_RESOURCE_LIMITS } from '../../src/agent/memory/memory-resource-limits.js'

const GROUP_A = '10001'
const GROUP_B = '10002'

test('personal memory derivative resource limits are frozen outside the Phase 7B contract', () => {
  assert.deepEqual(MEMORY_DERIVATIVE_RESOURCE_LIMITS, {
    personalPolicyWireBytes: 4 * 1_024,
    derivativeJobLogicalBytes: 1 * 1_024,
    derivativeJobRecords: 8_192,
    derivativeJobLogicalBytesTotal: 8 * 1_024 * 1_024,
    lexicalIndexRecords: 32_768,
    lexicalIndexLogicalBytes: 128 * 1_024 * 1_024,
    lexicalSqliteMainFileBytes: 256 * 1_024 * 1_024
  })
  assert.equal(Object.isFrozen(MEMORY_DERIVATIVE_RESOURCE_LIMITS), true)
})

function decision (
  deploymentMode: 'off' | 'explicit' | 'shadow' | 'automatic',
  enrollment: Readonly<{
    status: 'opted_out' | 'opted_in'
    candidateMode: 'off' | 'shadow' | 'policy_approved'
  }>,
  scene: Readonly<{ kind: 'private' } | { kind: 'group'; groupId: string }> = {
    kind: 'private'
  },
  groupAllowlist: readonly string[] = []
): PersonalMemoryPilotDecisionV1 {
  return decidePersonalMemoryPilotV1({
    deploymentMode,
    enrollment,
    scene,
    groupAllowlist
  })
}

test('personal memory pilot requires deployment mode, opt-in and group canary together', () => {
  const optedIn = Object.freeze({
    status: 'opted_in' as const,
    candidateMode: 'policy_approved' as const
  })
  assert.deepEqual(decision('off', optedIn), {
    status: 'disabled',
    reason: 'deployment_off',
    recall: false,
    explicitWrite: false,
    shadowCandidate: false,
    automaticCandidate: false
  })
  assert.equal(decision('explicit', {
    status: 'opted_out', candidateMode: 'off'
  }).reason, 'user_opted_out')
  assert.equal(decision('automatic', optedIn, {
    kind: 'group', groupId: GROUP_A
  }, [GROUP_B]).reason, 'group_not_allowed')

  const enabled = decision('automatic', optedIn, {
    kind: 'group', groupId: GROUP_A
  }, [GROUP_A])
  assert.deepEqual(enabled, {
    status: 'enabled',
    reason: 'enabled',
    recall: true,
    explicitWrite: true,
    shadowCandidate: false,
    automaticCandidate: true
  })
  assert.equal(Object.isFrozen(enabled), true)
})

test('personal memory candidate modes only narrow the deployment ceiling', () => {
  const explicit = decision('automatic', {
    status: 'opted_in', candidateMode: 'off'
  })
  assert.deepEqual(
    [explicit.recall, explicit.explicitWrite, explicit.shadowCandidate, explicit.automaticCandidate],
    [true, true, false, false]
  )

  const shadow = decision('automatic', {
    status: 'opted_in', candidateMode: 'shadow'
  })
  assert.deepEqual(
    [shadow.shadowCandidate, shadow.automaticCandidate],
    [true, false]
  )

  const deploymentShadow = decision('shadow', {
    status: 'opted_in', candidateMode: 'policy_approved'
  })
  assert.deepEqual(
    [deploymentShadow.shadowCandidate, deploymentShadow.automaticCandidate],
    [true, false]
  )
})

test('personal memory pilot rejects malformed, duplicate, accessor and proxy policy inputs', () => {
  assert.throws(() => decidePersonalMemoryPilotV1({
    deploymentMode: 'automatic',
    enrollment: { status: 'opted_in', candidateMode: 'policy_approved' },
    scene: { kind: 'group', groupId: GROUP_A },
    groupAllowlist: [GROUP_A, GROUP_A]
  }), TypeError)
  assert.throws(() => decidePersonalMemoryPilotV1(new Proxy({
    deploymentMode: 'off',
    enrollment: { status: 'opted_out', candidateMode: 'off' },
    scene: { kind: 'private' },
    groupAllowlist: []
  }, {})), TypeError)
  assert.throws(() => decidePersonalMemoryPilotV1({
    deploymentMode: 'off',
    get enrollment () {
      throw new Error('must not invoke accessors')
    },
    scene: { kind: 'private' },
    groupAllowlist: []
  } as never), TypeError)
})
