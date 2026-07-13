import { currentChannelTarget } from './visible-tool-support.js';
const inputSchema = {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false
};
export function createReportProgressTool(services) {
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
        resolveTarget: (_input, facts) => currentChannelTarget(facts),
        execute: async (input, context) => {
            return services.reportProgress(String(input.text ?? ''), context);
        }
    });
}
