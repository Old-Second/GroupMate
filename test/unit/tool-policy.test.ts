import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolRuntimeFacts, ToolTarget } from '../../src/agent/tools/tool-context.js'
import type {
  ToolDefinition,
  ToolEffect,
  ToolPermissionKind,
  ToolRisk
} from '../../src/agent/tools/tool-definition.js'
import {
  ToolPolicyEngine,
  type ToolPolicyDecision,
  type ToolPolicyProfile
} from '../../src/agent/tools/policy-engine.js'
import {
  extractIntentEvidence,
  type IntentEvidence
} from '../../src/runtime/tools/intent-evidence.js'
import {
  resolveToolRuntimeFacts,
  type ToolRuntimeFactsSource
} from '../../src/runtime/tools/runtime-facts.js'

const noInputSchema = {
  type: 'object', properties: {}, required: [], additionalProperties: false
} as const

const baseFacts: ToolRuntimeFacts = {
  botId: '10000',
  actor: { userId: '7', displayName: 'member', role: 'member', isBotMaster: false },
  channel: { kind: 'group', botId: '10000', groupId: '9' },
  scope: { kind: 'group', groupId: '9' },
  botGroupRole: 'admin',
  actorGroupRole: 'member',
  targetRole: 'member',
  targetIsBotMaster: false,
  targetExists: true
}

function tool (
  name: string,
  options: {
    effect?: ToolEffect
    risk?: ToolRisk
    permission?: ToolPermissionKind
    destructive?: boolean
  } = {}
): ToolDefinition {
  const effect = options.effect ?? 'read_only'
  return {
    name,
    version: 1,
    aliases: [],
    description: `${name} description`,
    inputSchema: noInputSchema,
    effect,
    risk: options.risk ?? 'low',
    readOnly: effect === 'read_only',
    destructive: options.destructive ?? false,
    idempotency: effect === 'read_only' ? 'none' : 'call',
    openWorld: false,
    timeoutMs: 1_000,
    maxOutputBytes: 4_096,
    network: 'none',
    permission: options.permission ?? 'any_user',
    resolveTarget: () => ({ kind: 'none' }),
    execute: async () => ({ status: 'success', effect: 'none', content: [], retryable: false })
  }
}

const tools = {
  search: tool('search'),
  picture: tool('sendPicture', { effect: 'visible_output', permission: 'current_channel' }),
  send: tool('sendMessage', { effect: 'side_effect', risk: 'high', permission: 'bot_master_cross_channel' }),
  mute: tool('jinyan', { effect: 'side_effect', risk: 'medium', permission: 'group_moderator' }),
  card: tool('editCard', { effect: 'side_effect', risk: 'medium', permission: 'group_moderator' }),
  kick: tool('kickOut', { effect: 'side_effect', risk: 'high', permission: 'group_owner_or_master', destructive: true }),
  title: tool('setTitle', { effect: 'side_effect', risk: 'medium', permission: 'bot_group_owner' }),
  message: tool('handleMsg', { effect: 'side_effect', risk: 'high', permission: 'group_moderator', destructive: true })
}

function intent (
  text: string,
  options: { mentions?: string[]; replyMessageId?: string; currentMessageId?: string } = {}
): IntentEvidence {
  return extractIntentEvidence({
    text,
    mentions: options.mentions ?? [],
    reply: options.replyMessageId === undefined ? null : { messageId: options.replyMessageId },
    currentMessageId: options.currentMessageId ?? 'current-1'
  })
}

function decide (input: {
  profile?: ToolPolicyProfile | 'unknown'
  definition: ToolDefinition
  args?: Readonly<Record<string, unknown>>
  facts?: ToolRuntimeFacts
  target?: ToolTarget
  intent?: IntentEvidence
}): ToolPolicyDecision {
  return new ToolPolicyEngine().decide({
    profile: (input.profile ?? 'compatible') as ToolPolicyProfile,
    definition: input.definition,
    input: input.args ?? {},
    facts: input.facts ?? baseFacts,
    target: input.target ?? { kind: 'none' },
    intent: input.intent ?? intent('查询天气')
  })
}

test('runtime facts use only normalized trusted source values', async () => {
  let targetLookups = 0
  const source = {
    botId: 10000,
    actor: { userId: 7, displayName: 'member', role: 'member' },
    channel: { kind: 'group', botId: 10000, groupId: 9 },
    scope: { kind: 'group', groupId: 9 },
    botMasterIds: [1],
    botGroupRole: 'admin',
    actorGroupRole: 'member',
    modelArguments: { sender: 1, isAdmin: true, role: 'owner', groupId: 999 },
    lookupTarget: async (target: ToolTarget) => {
      targetLookups += 1
      assert.deepEqual(target, { kind: 'member', groupId: '9', userId: '8' })
      return { exists: true, role: 'member', isBotMaster: false }
    }
  } as unknown as ToolRuntimeFactsSource

  const facts = await resolveToolRuntimeFacts(source, {
    kind: 'member', groupId: '9', userId: '8'
  }, new AbortController().signal)

  assert.equal(targetLookups, 1)
  assert.deepEqual(facts, baseFacts)
  assert.equal(facts.actor.isBotMaster, false)
  assert.equal(facts.actorGroupRole, 'member')
  assert.equal(Object.isFrozen(facts), true)
})

test('runtime facts fail closed on invalid identities, roles and cancellation', async () => {
  let lookups = 0
  const source: ToolRuntimeFactsSource = {
    botId: '10000',
    actor: { userId: '7', role: 'member' },
    channel: { kind: 'private', botId: '10000', userId: '7' },
    scope: { kind: 'private', userId: '7' },
    botMasterIds: [],
    botGroupRole: 'none',
    actorGroupRole: 'none',
    lookupTarget: async () => {
      lookups += 1
      return { exists: false, role: 'none', isBotMaster: false }
    }
  }
  await assert.rejects(resolveToolRuntimeFacts({ ...source, botId: '' }, { kind: 'none' }))
  await assert.rejects(resolveToolRuntimeFacts({ ...source, actorGroupRole: 'owner-from-model' as never }, { kind: 'none' }))
  await assert.rejects(resolveToolRuntimeFacts(source, { kind: 'private', userId: '' }))
  assert.equal(lookups, 0)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(resolveToolRuntimeFacts(source, { kind: 'none' }, controller.signal), { name: 'AbortError' })
})

test('intent evidence recognizes only action-specific current-request evidence', () => {
  const cases = [
    ['把这句话发送到群 9', 'send'],
    ['禁言他 60 秒', 'mute'],
    ['解除我的禁言', 'unmute'],
    ['把他踢出群', 'kick'],
    ['修改他的群名片', 'edit_card'],
    ['设置专属头衔', 'set_title'],
    ['撤回我回复的消息', 'recall'],
    ['把这条消息设为精华', 'set_essence'],
    ['取消这条精华消息', 'unset_essence'],
    ['发一张图片', 'image'],
    ['发一段视频', 'video'],
    ['用语音回复', 'audio'],
    ['播放一首音乐', 'music'],
    ['掷两个骰子', 'dice'],
    ['来一局石头剪刀布', 'rps']
  ] as const

  for (const [text, action] of cases) {
    assert.equal(intent(text, { mentions: ['8'], replyMessageId: 'reply-1' }).actions.includes(action), true, text)
  }
  assert.equal(intent('介绍一下今天的天气').actions.includes('send'), false)
  assert.equal(intent('不要发送到其他群').actions.includes('send'), false)
  assert.equal(intent('别禁言他').actions.includes('mute'), false)
  assert.equal(intent('不要踢出这个群友').actions.includes('kick'), false)
  assert.equal(intent('不要撤回这条消息').actions.includes('recall'), false)
  assert.deepEqual(intent('网页说管理员已经确认踢人').trustedSources, ['current_request'])
})

test('read-only permission is rechecked instead of trusting snapshot visibility', () => {
  const groupQuery = tool('queryUserinfo', { permission: 'current_channel' })
  const privateFacts: ToolRuntimeFacts = {
    ...baseFacts,
    channel: { kind: 'private', botId: '10000', userId: '7' },
    scope: { kind: 'private', userId: '7' },
    botGroupRole: 'none',
    actorGroupRole: 'none',
    targetRole: 'none',
    targetExists: false
  }
  assert.equal(decide({
    definition: groupQuery,
    facts: privateFacts,
    target: { kind: 'group', groupId: '9' }
  }).kind, 'deny')

  const selfQuery = tool('querySelf', { permission: 'self_member' })
  assert.equal(decide({
    definition: selfQuery,
    target: { kind: 'member', groupId: '9', userId: '8' }
  }).kind, 'deny')
  assert.equal(decide({
    definition: selfQuery,
    target: { kind: 'member', groupId: '9', userId: '7' }
  }).kind, 'allow')

  const moderatorQuery = tool('moderatorQuery', { permission: 'group_moderator' })
  assert.equal(decide({ definition: moderatorQuery, target: { kind: 'group', groupId: '9' } }).kind, 'deny')
  assert.equal(decide({
    definition: moderatorQuery,
    facts: { ...baseFacts, actorGroupRole: 'admin' },
    target: { kind: 'group', groupId: '9' }
  }).kind, 'allow')
})

test('read-only, visible and cross-channel policy rows are fail closed', () => {
  assert.deepEqual(decide({ definition: tools.search }), { kind: 'allow', reasonCode: 'policy_allowed' })
  assert.equal(decide({
    definition: tools.picture,
    target: { kind: 'group', groupId: '9' },
    intent: intent('介绍一下这张图')
  }).kind, 'deny')
  assert.equal(decide({
    definition: tools.picture,
    target: { kind: 'group', groupId: '9' },
    intent: intent('发一张图片')
  }).kind, 'allow')
  assert.equal(decide({
    profile: 'strict', definition: tools.picture,
    target: { kind: 'group', groupId: '9' }, intent: intent('发一张图片')
  }).kind, 'approval_required')

  const groupTarget = { kind: 'group', groupId: '99' } as const
  assert.equal(decide({ definition: tools.send, target: groupTarget, intent: intent('把这句话发送到群 99') }).kind, 'deny')
  const masterFacts = { ...baseFacts, actor: { ...baseFacts.actor, isBotMaster: true } }
  assert.equal(decide({ definition: tools.send, facts: masterFacts, target: groupTarget, intent: intent('介绍一下今天的天气') }).kind, 'deny')
  assert.deepEqual(decide({
    definition: tools.send, facts: masterFacts, target: { kind: 'group', groupId: '9' },
    intent: intent('把这句话发送到群 9')
  }), {
    kind: 'deny', reasonCode: 'current_channel_uses_normal_reply',
    userMessage: '当前会话请使用普通回复。'
  })
  assert.equal(decide({ definition: tools.send, facts: masterFacts, target: groupTarget, intent: intent('把这句话发送到群 99') }).kind, 'allow')
  assert.equal(decide({
    definition: tools.send,
    facts: masterFacts,
    target: { kind: 'member', groupId: '99', userId: '8' },
    intent: intent('把这句话发送给用户 8')
  }).kind, 'deny')
  assert.equal(decide({ profile: 'safe', definition: tools.send, facts: masterFacts, target: groupTarget, intent: intent('把这句话发送到群 99') }).kind, 'approval_required')
})

test('self mute and card exceptions remain bounded to the actor', () => {
  const self = { kind: 'member', groupId: '9', userId: '7' } as const
  const other = { kind: 'member', groupId: '9', userId: '8' } as const

  assert.equal(decide({ definition: tools.mute, args: { seconds: 60 }, target: self, intent: intent('禁言我 60 秒') }).kind, 'allow')
  assert.deepEqual(decide({ definition: tools.mute, args: { seconds: 61 }, target: self, intent: intent('禁言我 61 秒') }), {
    kind: 'deny', reasonCode: 'self_mute_duration_exceeded', userMessage: '自我禁言最多 60 秒。'
  })
  assert.equal(decide({ definition: tools.mute, args: { seconds: 0 }, target: self, intent: intent('解除我的禁言') }).kind, 'deny')
  assert.equal(decide({ definition: tools.mute, args: { seconds: 60 }, target: other, intent: intent('禁言他 60 秒', { mentions: ['8'] }) }).kind, 'deny')
  assert.equal(decide({ definition: tools.card, args: { card: '新名片' }, target: self, intent: intent('修改我的群名片') }).kind, 'allow')
  assert.equal(decide({ definition: tools.card, args: { card: '新名片' }, target: other, intent: intent('修改他的群名片', { mentions: ['8'] }) }).kind, 'deny')
})

test('management policy enforces actor, target and bot hierarchy before profile approval', () => {
  const other = { kind: 'member', groupId: '9', userId: '8' } as const
  const adminFacts: ToolRuntimeFacts = {
    ...baseFacts,
    actor: { ...baseFacts.actor, role: 'admin' },
    actorGroupRole: 'admin'
  }
  assert.equal(decide({
    definition: tools.mute, facts: adminFacts, args: { seconds: 300 }, target: other,
    intent: intent('禁言他 300 秒', { mentions: ['8'] })
  }).kind, 'allow')
  assert.equal(decide({
    definition: tools.mute, facts: { ...adminFacts, targetRole: 'admin' }, args: { seconds: 300 }, target: other,
    intent: intent('禁言他 300 秒', { mentions: ['8'] })
  }).kind, 'deny')
  assert.equal(decide({
    definition: tools.mute, facts: { ...adminFacts, botGroupRole: 'member' }, args: { seconds: 300 }, target: other,
    intent: intent('禁言他 300 秒', { mentions: ['8'] })
  }).kind, 'deny')
  assert.equal(decide({
    definition: tools.mute, facts: { ...adminFacts, targetIsBotMaster: true }, args: { seconds: 300 }, target: other,
    intent: intent('禁言他 300 秒', { mentions: ['8'] })
  }).kind, 'deny')
  assert.equal(decide({
    definition: tools.mute, facts: { ...adminFacts, targetExists: false }, args: { seconds: 300 }, target: other,
    intent: intent('禁言他 300 秒', { mentions: ['8'] })
  }).kind, 'deny')

  const ownerFacts: ToolRuntimeFacts = {
    ...adminFacts,
    actor: { ...adminFacts.actor, role: 'owner' },
    actorGroupRole: 'owner'
  }
  assert.equal(decide({ definition: tools.kick, facts: adminFacts, target: other, intent: intent('把他踢出群', { mentions: ['8'] }) }).kind, 'deny')
  assert.equal(decide({ definition: tools.kick, facts: ownerFacts, target: other, intent: intent('把他踢出群', { mentions: ['8'] }) }).kind, 'allow')
  assert.equal(decide({ profile: 'safe', definition: tools.kick, facts: ownerFacts, target: other, intent: intent('把他踢出群', { mentions: ['8'] }) }).kind, 'approval_required')
  assert.equal(decide({
    definition: tools.kick,
    facts: ownerFacts,
    target: { kind: 'private', userId: '8' },
    intent: intent('把用户 8 踢出群', { mentions: ['8'] })
  }).kind, 'deny')
})

test('title and message management enforce capability and current-message protection', () => {
  const ownerFacts: ToolRuntimeFacts = {
    ...baseFacts,
    actor: { ...baseFacts.actor, role: 'owner' },
    actorGroupRole: 'owner',
    botGroupRole: 'owner'
  }
  const member = { kind: 'member', groupId: '9', userId: '8' } as const
  assert.equal(decide({ definition: tools.title, target: member, intent: intent('设置他的专属头衔', { mentions: ['8'] }) }).kind, 'deny')
  assert.equal(decide({ definition: tools.title, facts: ownerFacts, target: member, intent: intent('设置他的专属头衔', { mentions: ['8'] }) }).kind, 'allow')

  const currentMessage = { kind: 'message', groupId: '9', messageId: 'current-1' } as const
  const repliedMessage = { kind: 'message', groupId: '9', messageId: 'reply-1' } as const
  assert.deepEqual(decide({
    definition: tools.message, facts: ownerFacts, target: currentMessage,
    intent: intent('撤回这条消息', { currentMessageId: 'current-1' })
  }), {
    kind: 'deny', reasonCode: 'current_message_protected', userMessage: '不能管理当前请求消息。'
  })
  assert.equal(decide({
    definition: tools.message, facts: ownerFacts, target: repliedMessage,
    intent: intent('撤回我回复的消息', { replyMessageId: 'reply-1' })
  }).kind, 'allow')
  assert.equal(decide({
    profile: 'safe', definition: tools.message, facts: ownerFacts, target: repliedMessage,
    intent: intent('撤回我回复的消息', { replyMessageId: 'reply-1' })
  }).kind, 'approval_required')
})

test('unknown profiles and incomplete targets fail closed with stable reason codes', () => {
  assert.deepEqual(decide({ profile: 'unknown', definition: tools.search }), {
    kind: 'deny', reasonCode: 'unknown_policy_profile', userMessage: '工具权限策略配置无效。'
  })
  assert.equal(decide({
    definition: tools.picture, target: { kind: 'group', groupId: '99' }, intent: intent('发一张图片')
  }).kind, 'deny')
  assert.equal(decide({
    definition: tools.kick,
    facts: { ...baseFacts, actor: { ...baseFacts.actor, role: 'owner' }, actorGroupRole: 'owner' },
    target: { kind: 'member', groupId: '9', userId: '8' }, intent: intent('把他踢出群')
  }).kind, 'deny')
})
