import { buildChatButtonContent } from '../yunzai-button-content.js';
import { materializeYunzaiForwardMessage } from '../presentation/yunzai-forward-message.js';
import { materializeYunzaiMagicSegment } from '../presentation/yunzai-magic-segment.js';
import { materializeYunzaiMusicSegment } from '../presentation/yunzai-music-segment.js';
function callable(segment, name) {
    return typeof segment[name] === 'function';
}
function invoke(segment, name, args) {
    return segment[name](...args);
}
export function createHostOutbound(dependencies) {
    const resourceValue = (resource) => {
        if (resource.kind === 'buffer')
            return Buffer.from(resource.data);
        if (resource.kind === 'remote_url')
            return resource.url;
        return resource.path;
    };
    const textAtomValue = (atom) => {
        const segment = dependencies.segment();
        if (atom.kind === 'text')
            return atom.text;
        if (atom.kind === 'at') {
            const target = atom.target === 'all' ? 'all' : atom.target.userId;
            return callable(segment, 'at')
                ? invoke(segment, 'at', [target])
                : { type: 'at', qq: target };
        }
        if (atom.kind === 'face') {
            return callable(segment, 'face')
                ? invoke(segment, 'face', [atom.faceId])
                : { type: 'face', id: atom.faceId };
        }
        return callable(segment, 'markdown')
            ? invoke(segment, 'markdown', [atom.markdown])
            : { type: 'markdown', data: { content: atom.markdown } };
    };
    const outboundMessage = async (receiver, part) => {
        const segment = dependencies.segment();
        if (part.media === 'text') {
            const values = part.atoms.map(textAtomValue);
            const buttons = buildChatButtonContent(part.buttons, dependencies.buttonPolicy.snapshot());
            if (buttons !== null)
                values.push({ type: 'button', content: buttons });
            return values.length === 1 ? values[0] : values;
        }
        if (part.media === 'picture') {
            return callable(segment, 'image')
                ? invoke(segment, 'image', [resourceValue(part.resource)])
                : { type: 'image', file: resourceValue(part.resource) };
        }
        if (part.media === 'voice') {
            return callable(segment, 'record')
                ? invoke(segment, 'record', [part.hostRecord ?? resourceValue(part.resource)])
                : { type: 'record', file: part.hostRecord ?? resourceValue(part.resource) };
        }
        if (part.media === 'video') {
            return callable(segment, 'video')
                ? invoke(segment, 'video', [resourceValue(part.resource)])
                : { type: 'video', file: resourceValue(part.resource) };
        }
        if (part.media === 'music') {
            return materializeYunzaiMusicSegment(segment, part.provider, part.id);
        }
        if (part.media === 'dice')
            return materializeYunzaiMagicSegment(segment, 'dice');
        if (part.media === 'rps')
            return materializeYunzaiMagicSegment(segment, 'rps', part.value);
        return await materializeYunzaiForwardMessage(receiver, part);
    };
    const outboundHost = Object.freeze({
        async forTarget(target) {
            const bot = await dependencies.botPicker.pick(target.botId);
            if (bot === null)
                return null;
            const host = bot;
            // A `group_user` scope carries both ids and the host picks its friend channel for it, so the
            // non-group branch reads `userId` off either remaining scope kind.
            const receiver = target.scope.kind === 'group'
                ? await host.pickGroup
                    ?.call(host, target.scope.groupId)
                : await host.pickFriend
                    ?.call(host, target.scope.userId);
            if (receiver === null || typeof receiver !== 'object' ||
                typeof receiver.sendMsg !== 'function')
                return null;
            const sink = receiver;
            return Object.freeze({
                async dispatch(part, quoteMessageId, signal) {
                    if (signal?.aborted === true)
                        throw signal.reason;
                    const message = await outboundMessage(receiver, part);
                    const send = sink.sendMsg;
                    if (quoteMessageId === undefined)
                        return await send.call(sink, message);
                    const segment = dependencies.segment();
                    const reply = callable(segment, 'reply')
                        ? invoke(segment, 'reply', [quoteMessageId])
                        : { type: 'reply', id: quoteMessageId };
                    const quoted = Array.isArray(message) ? [reply, ...message] : [reply, message];
                    return await send.call(sink, quoted);
                },
                async recall(messageId, signal) {
                    if (signal?.aborted === true)
                        throw signal.reason;
                    const recallMsg = sink.recallMsg;
                    return typeof recallMsg === 'function'
                        ? await recallMsg.call(sink, messageId)
                        : false;
                }
            });
        }
    });
    return Object.freeze({ resourceValue, textAtomValue, outboundMessage, outboundHost });
}
