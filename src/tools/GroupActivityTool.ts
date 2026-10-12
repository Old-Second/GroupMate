import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { resourceKey } from '../agent/tools/resource-key.js'
import type { GroupActivityService } from '../runtime/activities/GroupActivityService.js'
import { boundedJson, configurationFailure, invalidArguments } from './query-tool-support.js'
import type { StrictToolSchema } from '../agent/tools/tool-schema.js'

export function createGroupActivityTool (kind: 'reminder' | 'poll', service?: GroupActivityService): ToolDefinition {
  const name = kind === 'poll' ? 'groupPoll' : 'scheduledTask'
  const properties: Record<string, StrictToolSchema> = kind === 'poll' ? {
    operation: { type: 'string', enum: ['create', 'vote', 'retract', 'status', 'list', 'close', 'cancel'] },
    id: { type: 'string' }, title: { type: 'string' }, options: { type: 'array', items: { type: 'string' } },
    choices: { type: 'array', items: { type: 'integer' } }, closesAt: { type: 'string' }, timeZone: { type: 'string' }, multiple: { type: 'boolean' }
  } : {
    operation: { type: 'string', enum: ['create', 'status', 'list', 'cancel'] }, id: { type: 'string' }, text: { type: 'string' },
    at: { type: 'string' }, timeZone: { type: 'string' }, delaySeconds: { type: 'integer' }, intervalSeconds: { type: 'integer' }, occurrences: { type: 'integer' }
  }
  properties.offset = { type: 'integer' }
  return Object.freeze<ToolDefinition>({
    name, version: 1, aliases: [],
    description: kind === 'poll'
      ? '当前群投票与匿名汇总。create给出2～10个options、title、multiple；closesAt为具体当地时间，空则90天后截止，timeZone默认用Asia/Shanghai。vote只能代表当前发言者投票，choices为1起编号，可改票；retract撤自己的票。status/list查询；close提前结算，cancel取消，后两者只限发起人/当前管理员。使用真实返回的id，不得猜，不接受其他群/代投票。list每页4项，offset从0开始、按返回nextOffset续页；其他操作offset填0。未用字段填空字符串、空数组、false。到期自动发汇总，无需额外建提醒。'
      : '当前群持久定时任务/提醒/倒计时；支持create/status/list/cancel。create中text为提醒原文，at具体当地时间或delaySeconds倒计时二选一，timeZone=Asia/Shanghai等IANA。一次提醒intervalSeconds=0、occurrences=1；明确要求重复时intervalSeconds至少60，occurrences最多30，全部在90天内。重复按实际经过秒数计算，不支持cron或按当地日历周期重复。list每页4项，offset从0开始、按返回nextOffset续页；其他操作offset填0。未用字符串填空。仅提醒当前群，不执行任意命令/管理/跨群/额外模型调用。status展示倒计时；cancel限本人/管理员。返回真实id，发送回执未知不会重发，重启错过多次只发一条且跳过积压。',
    inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
    effect: 'side_effect', risk: 'low', readOnly: false, destructive: false, idempotency: 'semantic',
    openWorld: false, timeoutMs: 8000, maxOutputBytes: 32 * 1024, network: 'none', permission: 'current_channel',
    executionClass: 'side_effect', retrySafe: false,
    resourceKeys: (_input, facts) => Object.freeze([resourceKey('group-activities', facts.botId, facts.channel.kind === 'group' ? facts.channel.groupId : 'private')]),
    resolveTarget: (_input, facts) => facts.channel.kind === 'group'
      ? { kind: 'group', groupId: facts.channel.groupId } : { kind: 'none' },
    execute: async (input, context) => {
      if (service === undefined) return configurationFailure('群活动服务尚未初始化。')
      try {
        const output = await service.perform(kind, input, context.facts, context.runId, context.signal)
        return { status: 'success', effect: ['list', 'status'].includes(String(input.operation)) ? 'none' : 'background',
          content: [{ type: 'text', text: boundedJson(output, 9000) }], retryable: false }
      } catch (error) {
        if (error instanceof TypeError) return invalidArguments(error.message)
        return { status: 'indeterminate', effect: 'possible', errorCode: 'tool_outcome_unknown',
          userMessage: '群活动存储回执未确认，请先查看当前群任务；不会自动重试创建。', retryable: false }
      }
    }
  })
}

export function createGroupPollTool (service?: GroupActivityService): ToolDefinition { return createGroupActivityTool('poll', service) }
export function createScheduledTaskTool (service?: GroupActivityService): ToolDefinition { return createGroupActivityTool('reminder', service) }
