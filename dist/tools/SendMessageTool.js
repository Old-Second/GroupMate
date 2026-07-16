import { invalidArguments } from './query-tool-support.js';
import { cancelledResult, crossChannelDefinition, executionFailure, indeterminateResult, sessionAddressForTarget } from './visible-tool-support.js';
import { actorMaySendCrossChannel } from '../agent/tools/cross-channel-access.js';
import { crossChannelResourceKeys } from '../agent/tools/resource-key.js';
const inputSchema = {
    type: 'object', properties: {
        text: { type: 'string' },
        targetKind: { type: 'string', enum: ['group', 'private'] },
        targetId: { type: 'string' }
    },
    required: ['text', 'targetKind', 'targetId'], additionalProperties: false
};
export function createSendMessageTool(services) {
    return crossChannelDefinition({
        inputSchema,
        crossChannelAccess: services.crossChannelAccess,
        resourceKeys: crossChannelResourceKeys,
        execute: async (input, context) => {
            if (context.target.kind !== 'group' && context.target.kind !== 'private') {
                return {
                    status: 'denied', effect: 'none', reasonCode: 'cross_channel_disabled',
                    userMessage: '当前未允许跨会话发送。', retryable: false
                };
            }
            const audience = services.crossChannelAccess[context.target.kind];
            if (!actorMaySendCrossChannel(services.crossChannelAccess, context.target.kind, context.facts.actor.isBotMaster)) {
                return audience === 'master'
                    ? {
                        status: 'denied', effect: 'none', reasonCode: 'permission_denied',
                        userMessage: '当前身份不能执行该操作。', retryable: false
                    }
                    : {
                        status: 'denied', effect: 'none', reasonCode: 'cross_channel_disabled',
                        userMessage: '当前未允许跨会话发送。', retryable: false
                    };
            }
            const text = String(input.text ?? '').trim();
            const targetId = String(input.targetId ?? '').trim();
            if (text === '' || Buffer.byteLength(text, 'utf8') > 8_000 || !/^\d{1,32}$/.test(targetId)) {
                return invalidArguments('跨会话消息参数无效。');
            }
            try {
                const target = sessionAddressForTarget(context.facts.botId, context.target);
                if (target === null)
                    return executionFailure('消息发送失败。');
                const delivery = await services.qq.sendText(target, text, context.signal);
                if (delivery.kind === 'outcome_unknown')
                    return indeterminateResult();
                if (delivery.kind === 'failed_definite')
                    return executionFailure('消息发送失败。');
                return {
                    status: 'success', effect: 'background',
                    content: [{ type: 'text', text: '消息已发送。' }], retryable: false
                };
            }
            catch {
                return context.signal.aborted ? cancelledResult() : executionFailure('消息发送失败。');
            }
        }
    });
}
