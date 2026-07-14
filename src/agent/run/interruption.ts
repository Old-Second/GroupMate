export type ApprovalActorRole = 'bot_master' | 'group_owner' | 'group_admin' | 'member'

export interface ApprovalActorReference {
  readonly userId: string
  readonly role: ApprovalActorRole
}

export interface ApproverPolicy {
  readonly profile: 'compatible' | 'safe' | 'strict'
  readonly allowedRoles: readonly ApprovalActorRole[]
  readonly requireDifferentActor: boolean
}

export type ApprovalDecision = Readonly<{
  kind: 'approved' | 'rejected' | 'expired'
  decidedAt: string
  actor?: ApprovalActorReference
}>

export interface ApprovalInterruption {
  readonly schemaVersion: 1
  readonly approvalId: string
  readonly runId: string
  readonly step: number
  readonly callId: string
  readonly toolFingerprint: string
  readonly argumentHash: string
  readonly action: string
  readonly target: string
  readonly keyParameters: readonly string[]
  readonly requester: ApprovalActorReference
  readonly approverPolicy: ApproverPolicy
  readonly approvalMessageId?: string
  readonly createdAt: string
  readonly displayedAt?: string
  readonly expiresAt?: string
  readonly decision?: ApprovalDecision
}

const actorRoles: readonly ApprovalActorRole[] = [
  'bot_master',
  'group_owner',
  'group_admin',
  'member'
]
const policyProfiles: readonly ApproverPolicy['profile'][] = ['compatible', 'safe', 'strict']

function asRecord (value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertOnlyKeys (value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new TypeError(`${label} contains unknown keys`)
  }
}

function readString (value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${label} is invalid`)
  }
  return value
}

function readTimestamp (value: unknown, label: string): string {
  const timestamp = readString(value, label, 64)
  if (new Date(timestamp).toISOString() !== timestamp) throw new TypeError(`${label} is invalid`)
  return timestamp
}

function parseActor (value: unknown): ApprovalActorReference {
  const actor = asRecord(value, 'approval actor')
  assertOnlyKeys(actor, ['userId', 'role'], 'approval actor')
  if (!actorRoles.includes(actor.role as ApprovalActorRole)) {
    throw new TypeError('approval actor role is invalid')
  }
  return Object.freeze({
    userId: readString(actor.userId, 'approval actor user ID', 128),
    role: actor.role as ApprovalActorRole
  })
}

function parsePolicy (value: unknown): ApproverPolicy {
  const policy = asRecord(value, 'approver policy')
  assertOnlyKeys(policy, ['profile', 'allowedRoles', 'requireDifferentActor'], 'approver policy')
  if (!policyProfiles.includes(policy.profile as ApproverPolicy['profile'])) {
    throw new TypeError('approver policy profile is invalid')
  }
  if (!Array.isArray(policy.allowedRoles) || policy.allowedRoles.length === 0) {
    throw new TypeError('approver policy roles are invalid')
  }
  const allowedRoles = policy.allowedRoles.map(role => {
    if (!actorRoles.includes(role as ApprovalActorRole)) {
      throw new TypeError('approver policy role is invalid')
    }
    return role as ApprovalActorRole
  })
  if (new Set(allowedRoles).size !== allowedRoles.length) {
    throw new TypeError('approver policy roles contain duplicates')
  }
  if (typeof policy.requireDifferentActor !== 'boolean') {
    throw new TypeError('approver policy actor requirement is invalid')
  }
  return Object.freeze({
    profile: policy.profile as ApproverPolicy['profile'],
    allowedRoles: Object.freeze(allowedRoles),
    requireDifferentActor: policy.requireDifferentActor
  })
}

function parseDecision (value: unknown): ApprovalDecision {
  const decision = asRecord(value, 'approval decision')
  assertOnlyKeys(decision, ['kind', 'decidedAt', 'actor'], 'approval decision')
  if (!['approved', 'rejected', 'expired'].includes(String(decision.kind))) {
    throw new TypeError('approval decision kind is invalid')
  }
  return Object.freeze({
    kind: decision.kind as ApprovalDecision['kind'],
    decidedAt: readTimestamp(decision.decidedAt, 'approval decision timestamp'),
    ...(decision.actor === undefined ? {} : { actor: parseActor(decision.actor) })
  })
}

export function parseApprovalInterruption (value: unknown): ApprovalInterruption {
  const input = asRecord(value, 'approval interruption')
  assertOnlyKeys(input, [
    'schemaVersion', 'approvalId', 'runId', 'step', 'callId', 'toolFingerprint',
    'argumentHash', 'action', 'target', 'keyParameters', 'requester',
    'approverPolicy', 'approvalMessageId', 'createdAt', 'displayedAt', 'expiresAt',
    'decision'
  ], 'approval interruption')
  if (input.schemaVersion !== 1) throw new TypeError('approval interruption version is invalid')
  if (!Number.isSafeInteger(input.step) || Number(input.step) < 0) {
    throw new TypeError('approval interruption step is invalid')
  }
  if (!Array.isArray(input.keyParameters) || input.keyParameters.length > 8) {
    throw new TypeError('approval interruption parameters are invalid')
  }
  const keyParameters = input.keyParameters.map((parameter, index) => (
    readString(parameter, `approval interruption parameter ${index}`, 256)
  ))
  return Object.freeze({
    schemaVersion: 1,
    approvalId: readString(input.approvalId, 'approval ID', 128),
    runId: readString(input.runId, 'approval run ID', 128),
    step: input.step as number,
    callId: readString(input.callId, 'approval call ID', 128),
    toolFingerprint: readString(input.toolFingerprint, 'approval tool fingerprint', 128),
    argumentHash: readString(input.argumentHash, 'approval argument hash', 128),
    action: readString(input.action, 'approval action'),
    target: readString(input.target, 'approval target'),
    keyParameters: Object.freeze(keyParameters),
    requester: parseActor(input.requester),
    approverPolicy: parsePolicy(input.approverPolicy),
    ...(input.approvalMessageId === undefined
      ? {}
      : { approvalMessageId: readString(input.approvalMessageId, 'approval message ID', 128) }),
    createdAt: readTimestamp(input.createdAt, 'approval creation timestamp'),
    ...(input.displayedAt === undefined
      ? {}
      : { displayedAt: readTimestamp(input.displayedAt, 'approval display timestamp') }),
    ...(input.expiresAt === undefined
      ? {}
      : { expiresAt: readTimestamp(input.expiresAt, 'approval expiration timestamp') }),
    ...(input.decision === undefined ? {} : { decision: parseDecision(input.decision) })
  })
}
