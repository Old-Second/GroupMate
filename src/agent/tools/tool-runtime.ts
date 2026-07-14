import type { ToolCall } from './tool-call.js'
import type {
  ToolExecutionContext,
  ToolPreparationContext
} from './tool-context.js'
import type {
  PreparedToolCall,
  SerializablePreparedCapability
} from './prepared-capability.js'
import type { ToolSnapshot } from './tool-registry.js'
import type { ToolResult } from './tool-result.js'

export type { ToolExecutionContext, ToolPreparationContext } from './tool-context.js'
export type {
  PreparedToolCall,
  SerializablePreparedCapability
} from './prepared-capability.js'

export interface ToolRuntime {
  prepare(
    call: ToolCall,
    context: ToolPreparationContext,
    snapshot: ToolSnapshot
  ): Promise<PreparedToolCall>

  executePrepared(
    prepared: SerializablePreparedCapability,
    freshContext: ToolExecutionContext,
    snapshot: ToolSnapshot,
    signal: AbortSignal
  ): Promise<ToolResult>
}
