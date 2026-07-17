import { decideBymTrigger } from './bym-trigger.js';
import { proactiveProfile } from './presentation/presentation-profile.js';
import { createChatRequestLog, createChatResponseLog } from './safe-chat-logging.js';
function recordDiagnostic(port, entry) {
    try {
        port?.record(entry);
    }
    catch { }
}
function eventGroupId(event) {
    const value = event.group_id;
    return typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : null;
}
function eventActorId(event) {
    const value = event.sender?.user_id ?? event.user_id;
    return typeof value === 'string' || typeof value === 'number'
        ? String(value)
        : '';
}
function recallAfterMs(policy, retaliation) {
    if (!retaliation || !policy.retaliationRecallEnabled)
        return null;
    const seconds = Math.min(Math.max(Math.trunc(Number(policy.retaliationRecallSeconds) || 100), 1), 3_600);
    return seconds * 1_000;
}
function proactiveSystemInstruction(policy, retaliation) {
    const prefix = `你的名字是“${policy.assistantLabel}”，你是QQ群里的一名普通群友。` +
        '请结合用户发言和聊天记录作出回应，表现得随性自然，最好参与讨论、融入其中。' +
        '不要过分插科打诨，不知道说什么可以复读群友的话。' +
        '要求你做搜索、发图、发视频和音乐等操作时必须使用工具，不可以直接发[图片]蒙混过关。' +
        '优先使用中文；如果此时不需要自己说话，只回复<EMPTY>。';
    const suffix = '\n' +
        `你的回复应该尽可能简练，像人类一样随意，不要附加聊天记录格式（比如${policy.assistantLabel}：），禁止重复聊天记录。`;
    const customBudget = Math.max(0, 16_384 - prefix.length - suffix.length);
    const preset = policy.preset.slice(0, customBudget);
    const retaliationPrompt = retaliation
        ? policy.retaliationPrompt.slice(0, customBudget - preset.length)
        : '';
    return `${prefix}${preset}${retaliationPrompt}${suffix}`;
}
function assertPreparedIntent(prepared, expectedRecallAfterMs) {
    const route = prepared.route;
    if (route.requestKind !== 'proactive_chat' || route.profile !== 'proactive' ||
        route.presentationIntent.kind !== 'proactive' ||
        route.presentationIntent.recallAfterMs !== expectedRecallAfterMs ||
        prepared.evidence.prompt.trim() === '') {
        throw new TypeError('prepared BYM request is invalid');
    }
}
async function completeProactive(options, event, prepared, envelope) {
    const route = prepared.route;
    await options.completionCoordinator.complete({
        envelope,
        present: async (projection) => {
            const presentationSettings = await options.presentationSettings.load(route.actorId);
            const hooks = options.hooks.forActiveEvent(event);
            return await options.presenter.present(Object.freeze({
                route,
                profile: proactiveProfile({
                    recallAfterMs: route.presentationIntent.recallAfterMs
                }),
                result: projection.result,
                sessionPersistence: projection.sessionPersistence,
                settings: presentationSettings,
                citationForwards: Object.freeze([]),
                suggestions: Object.freeze([]),
                hooks
            }));
        }
    });
}
async function runBym(options, event) {
    const policy = options.policy.snapshot();
    if (!policy.enabled)
        return;
    const groupId = eventGroupId(event);
    if (groupId !== null && policy.disabledGroupIds.includes(groupId))
        return;
    const trigger = decideBymTrigger({
        message: event.msg,
        assistantLabel: policy.assistantLabel,
        hasLeadingAlias: event.hasAlias === true,
        recognizeLeadingAlias: policy.recognizeLeadingAlias
    });
    if (trigger.prompt === null)
        return;
    let probabilitySample = -1;
    if (!trigger.explicitlyAddressed) {
        const random = options.random();
        if (!Number.isFinite(random) || random < 0 || random >= 1)
            return;
        probabilitySample = Math.floor(random * 100);
    }
    if (probabilitySample >= policy.ratePercent)
        return;
    const prompt = trigger.prompt;
    const actorId = eventActorId(event);
    const retaliationHit = policy.retaliationWords.some(word => prompt.includes(word));
    const retaliation = retaliationHit &&
        !policy.retaliationBlacklistActorIds.includes(actorId);
    const recall = recallAfterMs(policy, retaliation);
    const presentationIntent = Object.freeze({
        schemaVersion: 1,
        kind: 'proactive',
        recallAfterMs: recall
    });
    const prepared = await options.requests.prepare({
        event,
        prompt,
        presentationIntent
    });
    assertPreparedIntent(prepared, recall);
    if (await options.promptScreening.isBlocked({
        event,
        prompt: prepared.evidence.prompt
    }))
        return;
    const envelope = await options.agent.handleEphemeral({
        event,
        prepared,
        systemInstructions: Object.freeze([
            proactiveSystemInstruction(policy, retaliation)
        ]),
        enableGroupContext: true,
        thinkingMode: policy.thinkingMode,
        reasoningEffort: policy.reasoningEffort
    });
    recordDiagnostic(options.diagnostics, createChatRequestLog({
        mode: 'api',
        stream: false,
        prompt: prepared.evidence.prompt,
        correlation: Object.freeze({
            runRef: envelope.runRef,
            terminalObservationId: 'not_attempted'
        })
    }));
    if (envelope.kind === 'paused')
        return;
    recordDiagnostic(options.diagnostics, createChatResponseLog({
        mode: 'api',
        correlation: Object.freeze({
            runRef: envelope.runRef,
            terminalObservationId: envelope.runRef === 'unavailable'
                ? 'not_attempted'
                : envelope.terminal?.snapshot.observationId ?? 'unavailable'
        }),
        response: envelope.kind === 'completed' && envelope.completion.kind === 'reply_text'
            ? { text: envelope.completion.text }
            : envelope.kind === 'failed'
                ? { error: true }
                : {}
    }));
    await completeProactive(options, event, prepared, envelope);
}
export function createYunzaiBymController(options) {
    return Object.freeze({
        async bym(event) {
            try {
                await runBym(options, event);
            }
            catch { }
            return false;
        }
    });
}
