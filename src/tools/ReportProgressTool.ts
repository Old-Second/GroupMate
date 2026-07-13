import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import type { AuthorizedToolContext, ToolRuntimeFacts } from '../agent/tools/tool-context.js'
import {
  currentChannelTarget,
  type VisibleToolServices
} from './visible-tool-support.js'

const inputSchema = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false
} as const

export function createReportProgressTool (services: VisibleToolServices): ToolDefinition {
  return Object.freeze({
    name: 'reportProgress',
    version: 1,
    aliases: Object.freeze([]),
    description: '仅在多步骤任务完成一个真实阶段后，向当前会话报告简短进度并继续任务。',
    inputSchema,
    effect: 'progress_output',
    risk: 'medium',
    readOnly: false,
    destructive: false,
    idempotency: 'semantic',
    openWorld: false,
    timeoutMs: 10_000,
    maxOutputBytes: 4 * 1024,
    network: 'none',
    permission: 'current_channel',
    resolveTarget: (_input: Readonly<Record<string, unknown>>, facts: ToolRuntimeFacts) => currentChannelTarget(facts),
    execute: async (input: Readonly<Record<string, unknown>>, context: AuthorizedToolContext) => {
      return services.reportProgress(String(input.text ?? ''), context)
    }
  })
}
