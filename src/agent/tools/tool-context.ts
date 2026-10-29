import type {
  ActorIdentity,
  ChannelIdentity,
  ConversationScope
} from '../contracts/identity.js'
import type { ApprovalDecision } from '../run/interruption.js'
import type { IntentEvidence } from '../../runtime/tools/intent-evidence.js'
import type { ToolPolicyProfile } from './policy-engine.js'

export type ToolTarget =
  | { readonly kind: 'none' }
  | { readonly kind: 'private'; readonly userId: string }
  | { readonly kind: 'group'; readonly groupId: string }
  | { readonly kind: 'member'; readonly groupId: string; readonly userId: string }
  | { readonly kind: 'message'; readonly groupId: string; readonly messageId: string }

export interface ToolRuntimeFacts {
  readonly botId: string
  readonly actor: ActorIdentity & { readonly isBotMaster: boolean }
  readonly channel: ChannelIdentity
  readonly scope: ConversationScope
  readonly botGroupRole: 'owner' | 'admin' | 'member' | 'none'
  readonly actorGroupRole: 'owner' | 'admin' | 'member' | 'none'
  readonly targetRole: 'owner' | 'admin' | 'member' | 'none'
  readonly targetIsBotMaster: boolean
  readonly targetExists: boolean
}

export interface AuthorizedToolContext {
  readonly runId: string
  readonly callId: string
  readonly snapshotId: string
  readonly facts: ToolRuntimeFacts
  readonly target: ToolTarget
  readonly signal: AbortSignal
}

export interface ToolPreparationContext {
  readonly runId: string
  readonly runRef?: string
  readonly profile: ToolPolicyProfile
  /**
   * Actor, channel and bot facts for the whole planned batch. One context serves
   * every call in it, so the target-derived fields describe no single call
   * target; the execution boundary re-resolves them per prepared capability.
   */
  readonly facts: ToolRuntimeFacts
  readonly intent: IntentEvidence
  readonly now: string
}

/** Facts here are resolved for the prepared capability's own target. */
export interface ToolExecutionContext extends ToolPreparationContext {
  readonly approval?: ApprovalDecision
}
