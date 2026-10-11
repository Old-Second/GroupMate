import { currentChannelResourceKeys } from '../agent/tools/resource-key.js';
import { invalidArguments } from './query-tool-support.js';
import { sendRemoteImages, visibleDefinition } from './visible-tool-support.js';
const inputSchema = {
    type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } } },
    required: ['urls'], additionalProperties: false
};
export function createSendPictureTool(services) {
    return visibleDefinition({
        name: 'sendPicture', description: '向当前会话发送一至四张公网图片。',
        inputSchema, network: 'open_http', resourceKeys: currentChannelResourceKeys,
        execute: async (input, context) => {
            const urls = Array.isArray(input.urls)
                ? input.urls.map(String).map(value => value.trim()).filter(Boolean).slice(0, 4) : [];
            if (urls.length === 0)
                return invalidArguments('没有可发送的图片地址。');
            return await sendRemoteImages(services, urls, context, '图片');
        }
    });
}
