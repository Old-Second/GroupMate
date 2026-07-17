import { getChatErrorPresentation } from './chat-error-presentation.js';
import { endAllConversations, endConversation, joinConversation, listConversations, resolveConversationCommandAddress } from './conversation-manager.js';
import { ordinaryProfile } from './presentation/presentation-profile.js';
import { normalizeSuggestions } from './presentation/reply-content.js';
import { createChatErrorLog, createChatRequestLog, createChatResponseLog } from './safe-chat-logging.js';
function freezeRule(rule) {
    return Object.freeze({ ...rule });
}
export function buildYunzaiChatRules(entryMode, conversationModePrefixes) {
    const modes = [...conversationModePrefixes].join('|');
    return Object.freeze([
        freezeRule({ reg: '^#(图片)?chat1[sS]*', fnc: 'chatgpt1' }),
        freezeRule({
            reg: entryMode === 'at' ? '^[^#][sS]*' : '^#(图片)?chat[^gpt][sS]*',
            fnc: 'chatgpt',
            log: false
        }),
        freezeRule({
            reg: '^#(chatgpt)?对话列表$', fnc: 'getAllConversations', permission: 'master'
        }),
        freezeRule({
            reg: `^#?(${modes})?(结束|新开|摧毁|毁灭|完结)对话([sS]*)$`,
            fnc: 'destroyConversations'
        }),
        freezeRule({
            reg: `^#?(${modes})?(结束|新开|摧毁|毁灭|完结)全部对话$`,
            fnc: 'endAllConversations',
            permission: 'master'
        }),
        freezeRule({ reg: '^#chatgpt图片模式$', fnc: 'switch2Picture' }),
        freezeRule({ reg: '^#chatgpt文本模式$', fnc: 'switch2Text' }),
        freezeRule({ reg: '^#chatgpt语音模式$', fnc: 'switch2Audio' }),
        freezeRule({ reg: '^#chatgpt语音换源', fnc: 'switchTTSSource' }),
        freezeRule({ reg: '^#chatgpt设置(语音角色|角色语音|角色)', fnc: 'setDefaultRole' }),
        freezeRule({
            reg: '#(OpenAI|openai)(剩余)?(余额|额度)', fnc: 'totalAvailable', permission: 'master'
        }),
        freezeRule({ reg: '^#(chatgpt)?加入对话', fnc: 'joinConversation' })
    ]);
}
function scalarId(value) {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function actorId(event) {
    return scalarId(event.sender?.user_id ?? event.user_id);
}
function botId(event) {
    return scalarId(event.self_id ?? event.bot?.uin);
}
function messageText(event) {
    return typeof event.msg === 'string' ? event.msg : '';
}
function booleanField(event, key) {
    return event[key] === true;
}
function atSegments(event) {
    if (!Array.isArray(event.message))
        return Object.freeze([]);
    return Object.freeze(event.message.filter(segment => segment !== null && typeof segment === 'object' &&
        segment.type === 'at'));
}
function mentionsSomebodyElse(event) {
    return !booleanField(event, 'atme') && !booleanField(event, 'atBot') &&
        atSegments(event).length > 0;
}
function eventIsGroup(event) {
    return event.isGroup === true || scalarId(event.group_id) !== '';
}
function conversationEvent(event) {
    const sender = event.sender;
    const message = Array.isArray(event.message)
        ? event.message.filter((value) => value !== null && typeof value === 'object')
        : undefined;
    return Object.freeze({
        isGroup: eventIsGroup(event),
        ...(typeof event.group_id === 'string' || typeof event.group_id === 'number'
            ? { group_id: event.group_id }
            : {}),
        ...(typeof event.user_id === 'string' || typeof event.user_id === 'number'
            ? { user_id: event.user_id }
            : {}),
        ...(typeof event.self_id === 'string' || typeof event.self_id === 'number'
            ? { self_id: event.self_id }
            : {}),
        ...(typeof event.bot?.uin === 'string' || typeof event.bot?.uin === 'number'
            ? { bot: Object.freeze({ uin: event.bot.uin }) }
            : {}),
        ...(sender === undefined
            ? {}
            : {
                sender: Object.freeze({
                    ...(typeof sender.user_id === 'string' || typeof sender.user_id === 'number'
                        ? { user_id: sender.user_id }
                        : {}),
                    ...(typeof sender.nickname === 'string' ? { nickname: sender.nickname } : {}),
                    ...(typeof sender.card === 'string' ? { card: sender.card } : {})
                })
            }),
        ...(message === undefined ? {} : { message: Object.freeze(message) })
    });
}
function removeBotDisplayName(event, prompt) {
    if (!eventIsGroup(event))
        return prompt;
    try {
        const hostBot = event.bot;
        const listing = hostBot?.gml;
        const member = listing instanceof Map
            ? listing.get(event.self_id ?? event.bot?.uin)
            : undefined;
        if (member === null || typeof member !== 'object')
            return prompt;
        const record = member;
        const names = [record.nickname, record.card]
            .filter((value) => typeof value === 'string' && value !== '');
        let result = prompt;
        for (const name of new Set(names))
            result = result.replace(`@${name}`, '').trim();
        return result;
    }
    catch {
        return prompt;
    }
}
function atModePrompt(event) {
    const message = messageText(event);
    if (message === '' || message.startsWith('#'))
        return null;
    if (eventIsGroup(event) && !booleanField(event, 'atme') &&
        !booleanField(event, 'atBot') && scalarId(event.at) !== botId(event)) {
        return null;
    }
    if (actorId(event) === botId(event))
        return null;
    return removeBotDisplayName(event, message.trim())
        .replace(/^｜本月已发送\d+条消息/, '')
        .trim();
}
function commandPrompt(event, pattern) {
    if (mentionsSomebodyElse(event))
        return null;
    const source = messageText(event).trimStart();
    const prompt = source.replace(pattern, '').trim();
    if (prompt === '')
        return null;
    return Object.freeze({
        prompt,
        forcePicture: source.startsWith('#图片')
    });
}
function listMatches(entries, event) {
    const group = scalarId(event.group_id);
    const actor = actorId(event);
    for (const entry of entries) {
        if (typeof entry !== 'string')
            continue;
        if (entry.startsWith('^') && entry.slice(1) === actor)
            return true;
        const separator = entry.indexOf('^');
        if (separator > 0 && eventIsGroup(event) &&
            entry.slice(0, separator) === group && entry.slice(separator + 1) === actor)
            return true;
        if (!entry.startsWith('^') && separator < 0 && eventIsGroup(event) && entry === group)
            return true;
    }
    return false;
}
function authorized(policy, event) {
    if (!booleanField(event, 'isMaster') && booleanField(event, 'isPrivate') &&
        !policy.enablePrivateChat)
        return false;
    if (listMatches(policy.whitelist, event))
        return true;
    return !listMatches(policy.blacklist, event);
}
function sameSessionAddress(left, right) {
    if (left.botId !== right.botId || left.scope.kind !== right.scope.kind)
        return false;
    if (left.scope.kind === 'group' && right.scope.kind === 'group') {
        return left.scope.groupId === right.scope.groupId;
    }
    if (left.scope.kind === 'private' && right.scope.kind === 'private') {
        return left.scope.userId === right.scope.userId;
    }
    if (left.scope.kind === 'group_user' && right.scope.kind === 'group_user') {
        return left.scope.groupId === right.scope.groupId && left.scope.userId === right.scope.userId;
    }
    return false;
}
function dateOnly(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
function displayDate(date) {
    return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ` +
        `${date.getHours()}:${date.getMinutes()}`;
}
function positiveTtl(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
        ? value
        : undefined;
}
function recordDiagnostic(port, entry) {
    try {
        port?.record(entry);
    }
    catch { }
}
async function safeSuggestions(port, enabled, prompt, envelope) {
    if (!enabled || envelope.kind !== 'completed' || envelope.completion.kind !== 'reply_text') {
        return Object.freeze([]);
    }
    try {
        return normalizeSuggestions(await port.generate({
            prompt,
            response: envelope.completion.text
        }));
    }
    catch {
        return Object.freeze([]);
    }
}
async function presentFinal(options, prepared, settings, profile, hooks, envelope) {
    await options.completionCoordinator.complete({
        envelope,
        present: async (projection) => await options.presenter.present(Object.freeze({
            route: prepared.route,
            profile,
            result: projection.result,
            sessionPersistence: projection.sessionPersistence,
            settings,
            citationForwards: Object.freeze([]),
            suggestions: await safeSuggestions(options.suggestions, settings.enableSuggestedResponses, prepared.evidence.prompt, envelope),
            hooks
        }))
    });
}
async function presentControlResult(options, event, result) {
    await options.controls.presentCommand({ event, message: result.message, quote: result.quote });
}
function assertOrdinaryPreparedRequest(value, forcePicture) {
    if (value.route.requestKind !== 'ordinary_chat' ||
        value.route.presentationIntent.forcePicture !== forcePicture ||
        value.evidence.prompt.trim() === '') {
        throw new TypeError('prepared chat request is invalid');
    }
}
async function runOrdinaryChat(options, event, policy, prompt, forcePicture) {
    if (!authorized(policy, event))
        return;
    let prepared;
    let requestDiagnosticRecorded = false;
    let latestCorrelation = Object.freeze({
        runRef: 'unavailable',
        terminalObservationId: 'not_attempted'
    });
    try {
        const actor = actorId(event);
        const entryAddress = resolveConversationCommandAddress(conversationEvent(event), policy.groupMerge);
        if (await options.policy.isMuted(entryAddress))
            return;
        const ocrTexts = policy.imgOcr
            ? await options.policy.ocrText(event)
            : Object.freeze([]);
        const presentationIntent = Object.freeze({
            schemaVersion: 1,
            kind: 'ordinary',
            forcePicture
        });
        const candidate = await options.requests.prepare({
            event,
            prompt,
            ocrTexts,
            groupMerge: policy.groupMerge,
            presentationIntent
        });
        assertOrdinaryPreparedRequest(candidate, forcePicture);
        prepared = candidate;
        if (!sameSessionAddress(prepared.route.sessionAddress, entryAddress)) {
            throw new TypeError('prepared chat route does not match the entry address');
        }
        if (await options.promptScreening.isBlocked({
            event,
            prompt: prepared.evidence.prompt
        })) {
            await options.controls.presentRouteNotice({
                route: prepared.route,
                message: '主人不让我回答你这种问题，真是抱歉了呢',
                quote: true
            });
            return;
        }
        const preferences = await options.preferences.load(actor);
        const augmentedPrompt = await options.policy.appendAzureEmotionFeedback({
            actorId: actor,
            prompt: prepared.evidence.prompt,
            preferences
        });
        const presentationSettings = await options.presentationSettings.load(actor);
        const profile = ordinaryProfile({
            forcePicture: prepared.route.presentationIntent.forcePicture,
            quoteCurrentRequest: presentationSettings.quoteReply &&
                prepared.route.requestMessageId !== undefined &&
                prepared.route.sessionAddress.scope.kind !== 'private'
        });
        const hooks = options.hooks.forActiveEvent(event);
        const lifecycle = await options.lifecycle.create({
            route: prepared.route,
            profile,
            settings: presentationSettings
        });
        const cast = policy.actorCastApi.trim() !== ''
            ? policy.actorCastApi
            : policy.promptPrefixOverride;
        const systemInstruction = `You are ${policy.assistantLabel}. ${cast} ` +
            `Current date: ${dateOnly((options.now ?? (() => new Date()))())}.`;
        const feedbackInstruction = augmentedPrompt.startsWith(prepared.evidence.prompt)
            ? augmentedPrompt.slice(prepared.evidence.prompt.length).trim()
            : augmentedPrompt.trim();
        const ttl = positiveTtl(policy.sessionTtlSeconds);
        const handleOptions = Object.freeze({
            presentationRoute: prepared.route,
            presentationLifecycle: lifecycle,
            systemInstructions: Object.freeze([
                systemInstruction,
                ...(feedbackInstruction === '' ? [] : [feedbackInstruction])
            ]),
            enableGroupContext: policy.enableGroupContext,
            thinkingMode: policy.thinkingMode,
            reasoningEffort: policy.reasoningEffort,
            ...(ttl === undefined ? {} : { sessionTtlSeconds: ttl })
        });
        const envelope = await options.agent.handle(event, prepared.evidence, handleOptions);
        recordDiagnostic(options.diagnostics, createChatRequestLog({
            mode: 'api',
            stream: false,
            prompt: prepared.evidence.prompt,
            correlation: Object.freeze({
                runRef: envelope.runRef,
                terminalObservationId: 'not_attempted'
            })
        }));
        requestDiagnosticRecorded = true;
        if (envelope.kind === 'paused')
            return;
        const responseCorrelation = Object.freeze({
            runRef: envelope.runRef,
            terminalObservationId: envelope.runRef === 'unavailable'
                ? 'not_attempted'
                : envelope.terminal?.snapshot.observationId ?? 'unavailable'
        });
        latestCorrelation = responseCorrelation;
        recordDiagnostic(options.diagnostics, createChatResponseLog({
            mode: 'api',
            correlation: responseCorrelation,
            response: envelope.kind === 'completed' && envelope.completion.kind === 'reply_text'
                ? { text: envelope.completion.text }
                : envelope.kind === 'failed'
                    ? { error: true }
                    : {}
        }));
        await presentFinal(options, prepared, presentationSettings, profile, hooks, envelope);
    }
    catch (error) {
        const presentation = getChatErrorPresentation(error);
        if (!requestDiagnosticRecorded && prepared !== undefined) {
            recordDiagnostic(options.diagnostics, createChatRequestLog({
                mode: 'api',
                stream: false,
                prompt: prepared.evidence.prompt,
                correlation: Object.freeze({
                    runRef: 'unavailable',
                    terminalObservationId: 'not_attempted'
                })
            }));
        }
        recordDiagnostic(options.diagnostics, createChatErrorLog({
            mode: 'api',
            error,
            category: presentation.code,
            correlation: latestCorrelation
        }));
        if (prepared !== undefined) {
            await options.controls.presentRouteNotice({
                route: prepared.route,
                message: presentation.message,
                quote: true
            });
            return;
        }
        await options.controls.presentCommand({
            event,
            message: presentation.message,
            quote: true
        });
    }
}
function modeFromSuffix(message) {
    const suffix = message.replace(/^#chatgpt语音换源/, '').trim();
    if (suffix === '1')
        return 'vits-uma-genshin-honkai';
    if (suffix === '2')
        return 'azure';
    if (suffix === '3')
        return 'voicevox';
    return null;
}
function roleField(mode) {
    if (mode === 'azure')
        return 'ttsRoleAzure';
    if (mode === 'voicevox')
        return 'ttsRoleVoiceVox';
    return 'ttsRole';
}
export function createYunzaiChatController(options, conversationModePrefixes) {
    const rules = buildYunzaiChatRules(options.policy.entryMode(), conversationModePrefixes);
    const controller = {
        rules,
        hostRules() {
            return rules.map(rule => ({ ...rule }));
        },
        async chatgpt(event) {
            const current = await options.policy.snapshot(event);
            const parsed = current.toggleMode === 'at'
                ? (() => {
                    const prompt = atModePrompt(event);
                    return prompt === null || prompt === ''
                        ? null
                        : Object.freeze({ prompt, forcePicture: false });
                })()
                : commandPrompt(event, /#(图片)?chat/);
            if (parsed === null)
                return false;
            await runOrdinaryChat(options, event, current, parsed.prompt, parsed.forcePicture);
        },
        async chatgpt1(event) {
            const parsed = commandPrompt(event, /#(图片)?chat1/);
            if (parsed === null)
                return false;
            const current = await options.policy.snapshot(event);
            await runOrdinaryChat(options, event, current, parsed.prompt, parsed.forcePicture);
            return true;
        },
        async getAllConversations(event) {
            await presentControlResult(options, event, await listConversations({
                bridge: options.agent.conversations,
                event: conversationEvent(event)
            }));
        },
        async destroyConversations(event) {
            const current = await options.policy.snapshot(event);
            await options.policy.clearAzureEmotionFeedback(actorId(event));
            await presentControlResult(options, event, await endConversation({
                bridge: options.agent.conversations,
                event: conversationEvent(event),
                groupMerge: current.groupMerge,
                toggleMode: current.toggleMode
            }));
        },
        async endAllConversations(event) {
            await presentControlResult(options, event, await endAllConversations({
                bridge: options.agent.conversations,
                event: conversationEvent(event)
            }));
        },
        async switch2Picture(event) {
            await options.preferences.patch(actorId(event), { usePicture: true, useTTS: false });
            await presentControlResult(options, event, {
                message: 'ChatGPT回复已转换为图片模式', quote: false
            });
        },
        async switch2Text(event) {
            await options.preferences.patch(actorId(event), { usePicture: false, useTTS: false });
            await presentControlResult(options, event, {
                message: 'ChatGPT回复已转换为文字模式', quote: false
            });
        },
        async switch2Audio(event) {
            const mode = options.ttsAdministration.getMode();
            if (!options.ttsAdministration.isConfigured(mode)) {
                await presentControlResult(options, event, {
                    message: options.ttsAdministration.missingConfigurationMessage(mode, 'enable'),
                    quote: false
                });
                return;
            }
            await options.preferences.patch(actorId(event), { useTTS: true, usePicture: false });
            await presentControlResult(options, event, {
                message: 'ChatGPT回复已转换为语音模式', quote: false
            });
        },
        async switchTTSSource(event) {
            const mode = modeFromSuffix(messageText(event));
            if (mode === null) {
                await presentControlResult(options, event, {
                    message: '请使用#chatgpt语音换源+数字进行换源。1为vits-uma-genshin-honkai，2为微软Azure，3为voicevox',
                    quote: false
                });
                return;
            }
            options.ttsAdministration.setMode(mode);
            await presentControlResult(options, event, {
                message: `语音转换源已切换为${mode}`, quote: false
            });
        },
        async setDefaultRole(event) {
            const mode = options.ttsAdministration.getMode();
            if (!options.ttsAdministration.isConfigured(mode)) {
                await presentControlResult(options, event, {
                    message: options.ttsAdministration.missingConfigurationMessage(mode, 'role'),
                    quote: false
                });
                return;
            }
            const requested = messageText(event)
                .replace(/^#chatgpt设置(语音角色|角色语音|角色)/, '')
                .trim() || '随机';
            const selection = options.ttsAdministration.selectVoice(mode, requested);
            if (selection.kind === 'selected') {
                await options.preferences.patch(actorId(event), {
                    [roleField(mode)]: selection.storedVoice
                });
            }
            await presentControlResult(options, event, {
                message: selection.message, quote: false
            });
        },
        async totalAvailable(event) {
            const snapshot = await options.billing.queryLastHundredDays((options.now ?? (() => new Date()))());
            const remaining = snapshot.hardLimitUsd - snapshot.totalUsageUsd;
            await presentControlResult(options, event, {
                message: `总额度：$${snapshot.hardLimitUsd}\n` +
                    `已经使用额度：$${snapshot.totalUsageUsd}\n` +
                    `当前剩余额度：$${remaining}\n` +
                    `到期日期(UTC)：${displayDate(snapshot.expiresAt)}`,
                quote: false
            });
        },
        async joinConversation(event) {
            const current = await options.policy.snapshot(event);
            const result = await joinConversation({
                bridge: options.agent.conversations,
                event: conversationEvent(event),
                groupMerge: current.groupMerge,
                toggleMode: current.toggleMode,
                ...(positiveTtl(current.sessionTtlSeconds) === undefined
                    ? {}
                    : { ttlSeconds: positiveTtl(current.sessionTtlSeconds) })
            });
            await presentControlResult(options, event, result);
            return result.success;
        }
    };
    return Object.freeze(controller);
}
