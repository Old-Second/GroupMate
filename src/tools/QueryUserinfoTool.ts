import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { memberResourceKeys } from '../agent/tools/resource-key.js'
import {
  boundedJson, invalidArguments, readOnlyDefinition, targetNotFound, textResult,
  upstreamFailure
} from './query-tool-support.js'

export interface GroupMemberSummary {
  readonly userId: string
  readonly nickname?: string
  readonly card?: string
  readonly role?: 'owner' | 'admin' | 'member'
  readonly title?: string
}

export interface QueryUserinfoToolOptions {
  readonly currentGroupMembers: (
    groupId: string,
    signal: AbortSignal
  ) => Promise<ReadonlyMap<string, GroupMemberSummary>>
}

const inputSchema = {
  type: 'object', properties: { userId: { type: 'string' } },
  required: ['userId'], additionalProperties: false
} as const

function safeMember (member: GroupMemberSummary): GroupMemberSummary {
  return Object.freeze({
    userId: String(member.userId),
    ...(member.nickname === undefined ? {} : { nickname: String(member.nickname).slice(0, 100) }),
    ...(member.card === undefined ? {} : { card: String(member.card).slice(0, 100) }),
    ...(member.role === undefined ? {} : { role: member.role }),
    ...(member.title === undefined ? {} : { title: String(member.title).slice(0, 100) })
  })
}

export function createQueryUserinfoTool (options: QueryUserinfoToolOptions): ToolDefinition {
  return readOnlyDefinition({
    name: 'queryUserinfo', description: '查询当前会话中群成员的公开群资料。',
    inputSchema, network: 'none', retrySafe: true, resourceKeys: memberResourceKeys,
    execute: async (input, context) => {
      const userId = String(input.userId ?? '').trim() || context.facts.actor.userId
      if (context.facts.channel.kind !== 'group') {
        if (userId !== context.facts.actor.userId) return invalidArguments('私聊中只能查询当前用户。')
        return textResult(boundedJson({
          userId: context.facts.actor.userId,
          displayName: context.facts.actor.displayName,
          role: context.facts.actor.role
        }))
      }
      try {
        const members = await options.currentGroupMembers(context.facts.channel.groupId, context.signal)
        const member = members.get(userId)
        if (member === undefined) return targetNotFound('当前群中未找到该成员。')
        return textResult(boundedJson(safeMember(member)))
      } catch {
        return upstreamFailure('群成员资料暂时不可用。')
      }
    }
  })
}
