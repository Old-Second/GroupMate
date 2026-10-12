import { currentChannelResourceKeys } from '../agent/tools/resource-key.js';
import { configurationFailure, invalidArguments } from './query-tool-support.js';
import { cancelledResult, executionFailure, sessionAddressForTarget, validResource, dispatchVisible, visibleDefinition } from './visible-tool-support.js';
const inputSchema = {
    type: 'object', properties: { text: { type: 'string' }, voice: { type: 'string' } },
    required: ['text', 'voice'], additionalProperties: false
};
export function createSendAudioMessageTool(services) {
    return visibleDefinition({
        name: 'sendAudioMessage', description: '将短文本转换为语音并发送到当前会话；voice 留空使用用户当前默认角色，指定角色须由当前服务支持。', inputSchema,
        resourceKeys: currentChannelResourceKeys,
        execute: async (input, context) => {
            if (!services.ttsAvailable)
                return configurationFailure('语音服务尚未配置。');
            const text = String(input.text ?? '').trim();
            const voice = String(input.voice ?? '').trim();
            if (text === '' || Buffer.byteLength(text, 'utf8') > 4_000)
                return invalidArguments('语音文本无效或过长。');
            try {
                const resource = await services.synthesizeAudio(text, voice, context.signal);
                if (!validResource(resource))
                    return executionFailure();
                const target = sessionAddressForTarget(context.facts.botId, context.target);
                if (target === null)
                    return executionFailure('语音发送失败。');
                return await dispatchVisible(() => services.qq.sendAudio(target, resource, context.signal), '语音已发送。', '语音发送失败。');
            }
            catch {
                return context.signal.aborted ? cancelledResult() : executionFailure('语音发送失败。');
            }
        }
    });
}
