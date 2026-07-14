import type { JsonObject } from './json-value.js'
import type {
  OpenAICompatibleProfile,
  ToolControlInput
} from './openai-compatible-profile.js'

const EMPTY_OBJECT: Readonly<JsonObject> = Object.freeze({})

export const standardOpenAIProfile: OpenAICompatibleProfile = Object.freeze({
  id: 'standard',
  version: 1,
  capabilities: Object.freeze({
    supportsDeveloperRole: true,
    supportsToolChoice: true,
    outputTokenField: 'max_completion_tokens',
    requiresAssistantContentForToolCalls: false,
    requiresReasoningStateForToolCalls: false
  }),
  encodeToolControls: (input: ToolControlInput) => input.enabled
    ? Object.freeze({
        tools: Object.freeze([...input.tools]),
        tool_choice: input.mode === 'required' ? 'required' : 'auto'
      })
    : Object.freeze({ tool_choice: 'none' }),
  encodeRequestExtensions: () => EMPTY_OBJECT,
  captureAssistantState: () => undefined,
  restoreAssistantExtensions: () => {
    throw new TypeError('standard profile does not accept provider state')
  },
  classifyError: () => undefined,
  recoveryHint: () => 'none'
})
