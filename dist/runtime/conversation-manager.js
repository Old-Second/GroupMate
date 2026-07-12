export const originalValues = ['api', 'API'];
function atSegments(bridge, event, toggleMode) {
    const segments = (event.message ?? []).filter((segment) => {
        return segment.type === 'at' &&
            (typeof segment.qq === 'string' || typeof segment.qq === 'number');
    });
    if (toggleMode !== 'at')
        return segments;
    const botId = bridge.resolveAddress(event, false).botId;
    return segments.filter(segment => String(segment.qq) !== botId);
}
function targetName(segment) {
    return String(segment.text ?? '').replace(/^@/, '');
}
export async function listConversations(input) {
    const summaries = [];
    for await (const value of input.bridge.list(input.event))
        summaries.push(value);
    if (summaries.length === 0) {
        return {
            message: '当前没有人正在与机器人对话',
            quote: true,
            success: false
        };
    }
    let response = '当前对话列表：(格式为【开始时间 ｜ qq昵称 ｜ 对话长度 ｜ 最后活跃时间】)\n';
    for (const value of summaries) {
        response += `${value.createdAt} ｜ ${value.startedBy.displayName ?? value.startedBy.userId} ｜ ${value.turnCount} ｜ ${value.updatedAt} \n`;
    }
    return { message: response, quote: true, success: true };
}
export async function endConversation(input) {
    const mentions = atSegments(input.bridge, input.event, input.toggleMode);
    if (mentions.length === 0) {
        const deleted = await input.bridge.delete(input.event, input.groupMerge);
        return deleted
            ? {
                message: '已结束当前对话，请@我进行聊天以开启新的对话',
                quote: true,
                success: true
            }
            : { message: '当前没有开启对话', quote: true, success: false };
    }
    const target = mentions[0];
    const name = targetName(target);
    const deleted = await input.bridge.delete(input.event, input.groupMerge, target.qq);
    return deleted
        ? {
            message: `已结束${name}的对话，TA仍可以@我进行聊天以开启新的对话`,
            quote: true,
            success: true
        }
        : { message: `当前${name}没有开启对话`, quote: true, success: false };
}
export async function endAllConversations(input) {
    const deleted = await input.bridge.deleteAll(input.event);
    return {
        message: `结束了${deleted}个用户的对话。`,
        quote: true,
        success: true
    };
}
export async function joinConversation(input) {
    const mentions = atSegments(input.bridge, input.event, input.toggleMode);
    if (mentions.length === 0) {
        return {
            message: '指令错误，使用本指令时请同时@某人',
            quote: true,
            success: false
        };
    }
    const target = mentions[0];
    const name = targetName(target);
    const joined = await input.bridge.fork({
        event: input.event,
        groupMerge: input.groupMerge,
        sourceUserId: target.qq,
        ttlSeconds: input.ttlSeconds
    });
    return joined
        ? { message: `加入${name}的对话成功`, quote: false, success: true }
        : { message: `${name}当前未开启对话，无法加入`, quote: true, success: false };
}
