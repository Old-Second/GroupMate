const EMPTY_OBJECT = Object.freeze({});
export const standardOpenAIProfile = Object.freeze({
    id: 'standard',
    version: 1,
    capabilities: Object.freeze({
        supportsDeveloperRole: true,
        supportsToolChoice: true,
        outputTokenField: 'max_completion_tokens',
        requiresAssistantContentForToolCalls: false,
        requiresReasoningStateForToolCalls: false
    }),
    encodeToolControls: (input) => input.enabled
        ? Object.freeze({
            tools: Object.freeze([...input.tools]),
            tool_choice: input.mode === 'required' ? 'required' : 'auto'
        })
        : Object.freeze({ tool_choice: 'none' }),
    encodeRequestExtensions: () => EMPTY_OBJECT,
    extractAssistantReasoning: () => undefined,
    captureAssistantState: () => undefined,
    restoreAssistantExtensions: () => {
        throw new TypeError('standard profile does not accept provider state');
    },
    classifyError: () => undefined,
    recoveryHint: () => 'none'
});
