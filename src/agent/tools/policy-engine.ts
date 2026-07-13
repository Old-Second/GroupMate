import type { IntentAction, IntentEvidence } from '../../runtime/tools/intent-evidence.js'
import type { ToolRuntimeFacts, ToolTarget } from './tool-context.js'
import type { ToolDefinition } from './tool-definition.js'
import type { ToolDenyCode } from './tool-result.js'

export type ToolPolicyProfile = 'compatible' | 'safe' | 'strict'

export type ToolPolicyDecision =
  | { readonly kind: 'allow'; readonly reasonCode: 'policy_allowed' }
  | {
      readonly kind: 'approval_required'
      readonly reasonCode: 'approval_required'
      readonly summaryCode: string
    }
  | { readonly kind: 'deny'; readonly reasonCode: ToolDenyCode; readonly userMessage: string }

export interface ToolPolicyInput {
  readonly profile: ToolPolicyProfile
  readonly definition: ToolDefinition
  readonly input: Readonly<Record<string, unknown>>
  readonly facts: ToolRuntimeFacts
  readonly target: ToolTarget
  readonly intent: IntentEvidence
}

const denialMessages: Readonly<Record<ToolDenyCode, string>> = Object.freeze({
  permission_denied: '当前身份不能执行该操作。',
  explicit_intent_required: '需要在当前消息中明确说明操作和目标。',
  current_channel_uses_normal_reply: '当前会话请使用普通回复。',
  target_invalid: '操作目标无效。',
  target_not_found: '没有找到可操作的目标。',
  target_protected: '不能操作机器人或受保护的主人账号。',
  bot_permission_denied: '机器人当前没有执行该操作的群权限。',
  cross_channel_disabled: '当前未允许跨会话发送。',
  approval_invalid: '该审批已失效，请重新发起。',
  tool_unavailable: '该工具在当前场景不可用。',
  invalid_arguments: '工具参数无效。',
  current_message_protected: '不能管理当前请求消息。',
  self_unmute_denied: '普通成员不能通过工具解除自己的禁言。',
  self_mute_duration_exceeded: '自我禁言最多 60 秒。',
  role_hierarchy_denied: '不能操作权限不低于自己的群成员。',
  unknown_policy_profile: '工具权限策略配置无效。'
})

const mediaActions: Readonly<Record<string, IntentAction>> = Object.freeze({
  draw: 'image',
  processPicture: 'image',
  sendPicture: 'image',
  sendAvatar: 'image',
  sendVideo: 'video',
  sendAudioMessage: 'audio',
  sendMusic: 'music',
  sendDice: 'dice',
  sendRPS: 'rps',
  queryGenshin: 'game',
  queryStarRail: 'game'
})

function deny (reasonCode: ToolDenyCode): ToolPolicyDecision {
  return Object.freeze({ kind: 'deny', reasonCode, userMessage: denialMessages[reasonCode] })
}

function allowed (): ToolPolicyDecision {
  return Object.freeze({ kind: 'allow', reasonCode: 'policy_allowed' })
}

function approval (toolName: string): ToolPolicyDecision {
  const summaryCode = toolName.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
  return Object.freeze({
    kind: 'approval_required',
    reasonCode: 'approval_required',
    summaryCode: `${summaryCode}_approval`
  })
}

function currentTarget (target: ToolTarget, facts: ToolRuntimeFacts): boolean {
  if (facts.channel.kind === 'private') return target.kind === 'private' && target.userId === facts.channel.userId
  return (target.kind === 'group' || target.kind === 'member' || target.kind === 'message') &&
    target.groupId === facts.channel.groupId
}

function explicitTarget (target: ToolTarget, facts: ToolRuntimeFacts, intent: IntentEvidence): boolean {
  if (target.kind === 'none') return true
  if (target.kind === 'member') {
    if (target.userId === facts.actor.userId) return true
    return intent.mentionUserIds.includes(target.userId) || intent.explicitTargetIds.includes(target.userId)
  }
  if (target.kind === 'message') {
    return intent.replyMessageId === target.messageId || intent.explicitTargetIds.includes(target.messageId)
  }
  if (target.kind === 'private') {
    return intent.mentionUserIds.includes(target.userId) || intent.explicitTargetIds.includes(target.userId)
  }
  return intent.explicitTargetIds.includes(target.groupId)
}

function intendedAction (definition: ToolDefinition, input: Readonly<Record<string, unknown>>): IntentAction | null {
  if (definition.name === 'sendMessage') return 'send'
  if (definition.name === 'jinyan') return input.seconds === 0 ? 'unmute' : 'mute'
  if (definition.name === 'kickOut') return 'kick'
  if (definition.name === 'editCard') return 'edit_card'
  if (definition.name === 'setTitle') return 'set_title'
  if (definition.name === 'handleMsg') {
    if (input.type === 'essence') return 'set_essence'
    if (input.type === 'unessence') return 'unset_essence'
    return 'recall'
  }
  return mediaActions[definition.name] ?? null
}

function hasManagementCapability (facts: ToolRuntimeFacts): boolean {
  return facts.botGroupRole === 'owner' || facts.botGroupRole === 'admin'
}

function actorCanManageMember (facts: ToolRuntimeFacts): boolean {
  if (facts.actor.isBotMaster) return true
  if (facts.actorGroupRole === 'owner') return facts.targetRole === 'admin' || facts.targetRole === 'member'
  if (facts.actorGroupRole === 'admin') return facts.targetRole === 'member'
  return false
}

function hardManagementGate (input: ToolPolicyInput): ToolPolicyDecision | null {
  const { definition, facts, target, intent } = input
  const expectedTargetKind = definition.name === 'handleMsg' ? 'message' : 'member'
  if (target.kind !== expectedTargetKind) return deny('target_invalid')
  if (facts.channel.kind !== 'group' || target.groupId !== facts.channel.groupId) return deny('target_invalid')
  if (!facts.targetExists) return deny('target_not_found')
  if (definition.name === 'handleMsg' && target.kind === 'message' && intent.currentMessageId === target.messageId) {
    return deny('current_message_protected')
  }
  if (!explicitTarget(target, facts, intent)) return deny('explicit_intent_required')
  const action = intendedAction(definition, input.input)
  if (action === null || !intent.actions.includes(action)) return deny('explicit_intent_required')
  if (!hasManagementCapability(facts)) return deny('bot_permission_denied')

  if (target.kind === 'member') {
    if (target.userId === facts.botId || facts.targetIsBotMaster) return deny('target_protected')
    const isSelf = target.userId === facts.actor.userId
    if (isSelf && definition.name === 'jinyan') {
      const seconds = input.input.seconds
      if (!Number.isInteger(seconds) || typeof seconds !== 'number' || seconds < 0) return deny('invalid_arguments')
      if (seconds === 0) return deny('self_unmute_denied')
      if (seconds > 60) return deny('self_mute_duration_exceeded')
      return null
    }
    if (isSelf && definition.name === 'editCard') return null
    if (!actorCanManageMember(facts)) return deny(
      facts.actorGroupRole === 'member' && !facts.actor.isBotMaster ? 'permission_denied' : 'role_hierarchy_denied'
    )
    if (definition.name === 'kickOut' && facts.targetRole !== 'member') return deny('role_hierarchy_denied')
  }

  if (definition.name === 'kickOut' && !facts.actor.isBotMaster && facts.actorGroupRole !== 'owner') {
    return deny('permission_denied')
  }
  if (definition.name === 'setTitle') {
    if (facts.botGroupRole !== 'owner') return deny('bot_permission_denied')
    if (!facts.actor.isBotMaster && facts.actorGroupRole !== 'owner' && facts.actorGroupRole !== 'admin') {
      return deny('permission_denied')
    }
  }
  if (definition.name === 'handleMsg') {
    if (target.kind !== 'message') return deny('target_invalid')
    if (!facts.actor.isBotMaster && facts.actorGroupRole !== 'owner' && facts.actorGroupRole !== 'admin') {
      return deny('permission_denied')
    }
  }
  return null
}

function requiresSafeApproval (input: ToolPolicyInput): boolean {
  const { definition, target, facts } = input
  if (definition.name === 'sendMessage' || definition.name === 'kickOut' || definition.name === 'handleMsg') return true
  if (target.kind === 'member' && target.userId !== facts.actor.userId &&
    ['jinyan', 'editCard', 'setTitle'].includes(definition.name)) return true
  return false
}

export class ToolPolicyEngine {
  decide (input: ToolPolicyInput): ToolPolicyDecision {
    if (input.profile !== 'compatible' && input.profile !== 'safe' && input.profile !== 'strict') {
      return deny('unknown_policy_profile')
    }
    if (input.definition.effect === 'read_only') {
      if (input.definition.permission === 'any_user') return allowed()
      if (input.definition.permission === 'current_channel') {
        return currentTarget(input.target, input.facts) && input.facts.targetExists
          ? allowed()
          : deny('target_invalid')
      }
      if (input.definition.permission === 'cross_channel') {
        if (input.target.kind !== 'group' && input.target.kind !== 'private') return deny('target_invalid')
        if (currentTarget(input.target, input.facts)) return deny('target_invalid')
        const audience = input.definition.crossChannelAccess?.[input.target.kind]
        if (audience === undefined || audience === 'disabled' ||
          (audience === 'master' && !input.facts.actor.isBotMaster) ||
          !input.facts.targetExists || !explicitTarget(input.target, input.facts, input.intent)) {
          return deny('target_invalid')
        }
        return allowed()
      }
      if (input.facts.channel.kind !== 'group') return deny('target_invalid')
      if (!currentTarget(input.target, input.facts) || !input.facts.targetExists) return deny('target_invalid')
      if (input.definition.permission === 'self_member') {
        return input.target.kind === 'member' && input.target.userId === input.facts.actor.userId
          ? allowed()
          : deny('permission_denied')
      }
      if (input.definition.permission === 'group_moderator' &&
        !input.facts.actor.isBotMaster && input.facts.actorGroupRole !== 'owner' && input.facts.actorGroupRole !== 'admin') {
        return deny('permission_denied')
      }
      if (input.definition.permission === 'group_owner_or_master' &&
        !input.facts.actor.isBotMaster && input.facts.actorGroupRole !== 'owner') {
        return deny('permission_denied')
      }
      if (input.definition.permission === 'bot_group_owner' && input.facts.botGroupRole !== 'owner') {
        return deny('bot_permission_denied')
      }
      return allowed()
    }

    const action = intendedAction(input.definition, input.input)
    if (input.definition.permission === 'current_channel') {
      if (!currentTarget(input.target, input.facts)) return deny('target_invalid')
      if (action === null || !input.intent.actions.includes(action)) return deny('explicit_intent_required')
    } else if (input.definition.permission === 'cross_channel') {
      if (input.target.kind !== 'group' && input.target.kind !== 'private') return deny('target_invalid')
      if (currentTarget(input.target, input.facts)) return deny('current_channel_uses_normal_reply')
      const audience = input.definition.crossChannelAccess?.[input.target.kind]
      if (audience === undefined) return deny('permission_denied')
      if (audience === 'disabled') return deny('cross_channel_disabled')
      if (audience === 'master' && !input.facts.actor.isBotMaster) return deny('permission_denied')
      if (!input.facts.targetExists) return deny('target_not_found')
      if (!explicitTarget(input.target, input.facts, input.intent) || action === null || !input.intent.actions.includes(action)) {
        return deny('explicit_intent_required')
      }
    } else {
      const denied = hardManagementGate(input)
      if (denied !== null) return denied
    }

    if (input.profile === 'strict' || (input.profile === 'safe' && requiresSafeApproval(input))) {
      return approval(input.definition.name)
    }
    return allowed()
  }
}
