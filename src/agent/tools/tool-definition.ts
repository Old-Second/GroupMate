import type { AuthorizedToolContext, ToolRuntimeFacts, ToolTarget } from './tool-context.js'
import type { ToolResult } from './tool-result.js'
import type { StrictToolSchema } from './tool-schema.js'

export type ToolEffect = 'read_only' | 'visible_output' | 'side_effect'
export type ToolRisk = 'low' | 'medium' | 'high'
export type ToolPermissionKind =
  | 'any_user'
  | 'current_channel'
  | 'bot_master_cross_channel'
  | 'self_member'
  | 'group_moderator'
  | 'group_owner_or_master'
  | 'bot_group_owner'

export interface ToolDefinition<Input = Readonly<Record<string, unknown>>> {
  readonly name: string
  readonly version: 1
  readonly aliases: readonly string[]
  readonly description: string
  readonly inputSchema: StrictToolSchema
  readonly effect: ToolEffect
  readonly risk: ToolRisk
  readonly readOnly: boolean
  readonly destructive: boolean
  readonly idempotency: 'none' | 'call' | 'semantic'
  readonly openWorld: boolean
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly network: 'none' | 'fixed_hosts' | 'open_http'
  readonly permission: ToolPermissionKind
  resolveTarget(input: Input, facts: ToolRuntimeFacts): ToolTarget
  execute(input: Input, context: AuthorizedToolContext): Promise<ToolResult>
}
