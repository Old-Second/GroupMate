import { CONVERSATION_ADDRESS_MAX_LENGTH, CONVERSATION_DETAIL_LABELS, CONVERSATION_TONE_LABELS, conversationDetailLabel, conversationToneLabel, hasConversationPreferences, parseConversationDetail, parseConversationTone, validateConversationAddress } from './conversation-preferences.js';
const COMMAND = '#对话偏好';
const RULE = Object.freeze({ reg: '^#对话偏好[\\s\\S]*$', fnc: 'conversationPreference' });
const FIELD_NAMES = Object.freeze({
    address: '称呼', tone: '语气', detail: '详略'
});
const SUBCOMMANDS = Object.freeze(['查看', '帮助', '称呼', '语气', '详略', '清除']);
const USAGE = [
    '对话偏好只在回复你本人的请求时生效，不会改变机器人人设和群规则。用法：',
    `${COMMAND} 查看`,
    `${COMMAND} 称呼 小陈`,
    `${COMMAND} 语气 ${CONVERSATION_TONE_LABELS.join('/')}/默认`,
    `${COMMAND} 详略 简短/默认/详细`,
    `${COMMAND} 清除 称呼/语气/详略/全部`
].join('\n');
const ADDRESS_REJECTIONS = Object.freeze({
    empty: `请写上称呼，例如：${COMMAND} 称呼 小陈`,
    line_break: '称呼只能是一行文字。',
    too_long: `称呼最多 ${CONVERSATION_ADDRESS_MAX_LENGTH} 个字。`,
    invalid_character: '称呼只能包含文字、数字和空格、·、-、_ 等少量连接符号。',
    instruction_like: '称呼不能像指令、身份或权限说明，换一个普通称呼吧。',
    blocked: '称呼包含屏蔽词，换一个吧。'
});
const DISABLED_MESSAGE = '主人已关闭对话偏好，暂时不能修改；已有设置仍可以查看和清除。';
const SAVE_FAILED_MESSAGE = '对话偏好暂时无法保存，请稍后再试。';
function scalar(value) {
    return typeof value === 'string' || typeof value === 'number'
        ? String(value).normalize('NFC').trim()
        : '';
}
function parseCommand(text) {
    const body = text.normalize('NFC').slice(COMMAND.length).replace(/^[ \t\u3000]+/u, '');
    if (body.trim() === '')
        return Object.freeze({ subcommand: '查看', value: '' });
    const subcommand = SUBCOMMANDS.find(name => body.startsWith(name)) ?? null;
    return Object.freeze({
        subcommand,
        value: subcommand === null ? body : body.slice(subcommand.length)
    });
}
function describe(preferences, enabled) {
    if (preferences === null || !hasConversationPreferences(preferences)) {
        return `你还没有设置对话偏好。\n${USAGE}`;
    }
    const lines = ['你的对话偏好：'];
    if (preferences.address !== undefined)
        lines.push(`称呼：${preferences.address}`);
    if (preferences.tone !== undefined)
        lines.push(`语气：${conversationToneLabel(preferences.tone)}`);
    if (preferences.detail !== undefined)
        lines.push(`详略：${conversationDetailLabel(preferences.detail)}`);
    lines.push(enabled
        ? '只在回复你本人的请求时生效。'
        : '主人已关闭对话偏好，当前不会生效。');
    return lines.join('\n');
}
function without(preferences, field) {
    const { [field]: _removed, ...rest } = preferences ?? { schemaVersion: 1 };
    return Object.freeze({ ...rest, schemaVersion: 1 });
}
function clearTarget(value) {
    const name = value.trim();
    if (name === '全部')
        return 'all';
    for (const [field, label] of Object.entries(FIELD_NAMES)) {
        if (label === name)
            return field;
    }
    return null;
}
export function createConversationPreferenceController(options) {
    const update = async (event, actorId, next, message) => {
        try {
            await options.store.save(actorId, next(await options.store.load(actorId)));
        }
        catch {
            await options.reply(event, SAVE_FAILED_MESSAGE);
            return;
        }
        await options.reply(event, message);
    };
    const setAddress = async (event, actorId, value) => {
        const address = validateConversationAddress(value, await options.blockWords(actorId));
        if (!address.ok) {
            await options.reply(event, ADDRESS_REJECTIONS[address.reason]);
            return;
        }
        await update(event, actorId, current => Object.freeze({
            ...without(current, 'address'), address: address.address
        }), `好的，以后回复你时称呼你“${address.address}”。`);
    };
    const setTone = async (event, actorId, value) => {
        const tone = parseConversationTone(value);
        if (tone === null) {
            await options.reply(event, `语气可选：${CONVERSATION_TONE_LABELS.join('、')}、默认。`);
            return;
        }
        await update(event, actorId, current => tone === 'default'
            ? without(current, 'tone')
            : Object.freeze({ ...without(current, 'tone'), tone }), tone === 'default' ? '已恢复默认语气。' : `已把对你的语气设为“${conversationToneLabel(tone)}”。`);
    };
    const setDetail = async (event, actorId, value) => {
        const detail = parseConversationDetail(value);
        if (detail === null) {
            await options.reply(event, `详略可选：${CONVERSATION_DETAIL_LABELS[0]}、默认、${CONVERSATION_DETAIL_LABELS[1]}。`);
            return;
        }
        await update(event, actorId, current => detail === 'default'
            ? without(current, 'detail')
            : Object.freeze({ ...without(current, 'detail'), detail }), detail === 'default' ? '已恢复默认详略。' : `已把回答详略设为“${conversationDetailLabel(detail)}”。`);
    };
    return Object.freeze({
        hostRules() {
            return [{ ...RULE }];
        },
        async conversationPreference(event) {
            const actorId = scalar(event.sender?.user_id ?? event.user_id);
            const botId = scalar(event.self_id ?? event.bot?.uin);
            if (actorId === '' || actorId === botId)
                return false;
            const text = typeof event.msg === 'string' ? event.msg : '';
            if (!text.startsWith(COMMAND))
                return false;
            const { subcommand, value } = parseCommand(text);
            const enabled = options.enabled();
            if (subcommand === null || subcommand === '帮助') {
                await options.reply(event, USAGE);
            }
            else if (subcommand === '查看') {
                let current;
                try {
                    current = await options.store.load(actorId);
                }
                catch {
                    await options.reply(event, '对话偏好暂时无法读取，请稍后再试。');
                    return true;
                }
                await options.reply(event, describe(current, enabled));
            }
            else if (subcommand === '清除') {
                // Clearing stays available with the owner switch off: it only removes data.
                const target = clearTarget(value);
                if (target === null) {
                    await options.reply(event, `请说明要清除哪一项：${COMMAND} 清除 称呼、语气、详略或全部。`);
                }
                else {
                    await update(event, actorId, current => target === 'all' ? null : without(current, target), target === 'all' ? '已清除全部对话偏好。' : `已清除${FIELD_NAMES[target]}。`);
                }
            }
            else if (!enabled) {
                await options.reply(event, DISABLED_MESSAGE);
            }
            else if (subcommand === '称呼') {
                await setAddress(event, actorId, value);
            }
            else if (subcommand === '语气') {
                await setTone(event, actorId, value);
            }
            else {
                await setDetail(event, actorId, value);
            }
            return true;
        }
    });
}
