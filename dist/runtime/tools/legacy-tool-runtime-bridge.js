import { randomBytes, randomUUID } from 'node:crypto';
import { ToolExecutor } from '../../agent/tools/tool-executor.js';
import { ToolPolicyEngine } from '../../agent/tools/policy-engine.js';
import { ToolRegistry } from '../../agent/tools/tool-registry.js';
import { shouldFinalizeToolResult, toolResultForModel } from '../../agent/tools/tool-result.js';
import { ApprovalCommandService, sha256ApprovalValue } from './approval-command.js';
import { InMemoryPendingCallStore } from './in-memory-pending-call-store.js';
import { extractIntentEvidence } from './intent-evidence.js';
import { PolicyFetch } from './policy-fetch.js';
import { RedisApprovalStore } from './redis-approval-store.js';
import { RedisIdempotencyStore } from './redis-idempotency-store.js';
import { resolveToolRuntimeFacts } from './runtime-facts.js';
import { createManagementToolDefinitions, createQueryToolRuntime, createVisibleToolDefinitions } from './tool-runtime-factory.js';
export class ToolRuntimeConfigurationError extends Error {
    code;
    constructor(code) {
        const messages = {
            unknown_policy_profile: '工具权限策略配置无效。',
            runtime_not_found: '工具运行上下文已失效。',
            runtime_capacity_exceeded: '工具运行上下文容量已满。'
        };
        super(messages[code]);
        this.name = 'ToolRuntimeConfigurationError';
        this.code = code;
    }
}
function policyProfile(value) {
    if (value !== 'compatible' && value !== 'safe' && value !== 'strict') {
        throw new ToolRuntimeConfigurationError('unknown_policy_profile');
    }
    return value;
}
function stableFeedback(result) {
    const feedback = toolResultForModel(result).trim();
    return feedback === '' ? '工具执行完成。' : feedback;
}
function approvalFeedback(outcome) {
    return `操作需要确认。请在 ${outcome.expiresAt} 前发送“#确认 ${outcome.token}”，或发送“#拒绝 ${outcome.token}”。`;
}
export function createLegacyToolRuntimeBridge(options) {
    const maxActiveRuns = options.maxActiveRuns ?? 64;
    if (!Number.isSafeInteger(maxActiveRuns) || maxActiveRuns < 1 || maxActiveRuns > 256) {
        throw new TypeError('active tool run limit is invalid');
    }
    const runTtlMs = options.runTtlMs ?? 6 * 60 * 1_000;
    if (!Number.isSafeInteger(runTtlMs) || runTtlMs < 30_000 || runTtlMs > 15 * 60 * 1_000) {
        throw new TypeError('tool run TTL is invalid');
    }
    const runs = new Map();
    const expiryTimers = new Map();
    const removeRun = (snapshotId) => {
        const existed = runs.delete(snapshotId);
        const timer = expiryTimers.get(snapshotId);
        if (timer !== undefined)
            clearTimeout(timer);
        expiryTimers.delete(snapshotId);
        if (existed)
            options.onRunExpired?.(snapshotId);
    };
    return Object.freeze({
        async begin(input) {
            if (typeof input.prompt !== 'string' || Buffer.byteLength(input.prompt, 'utf8') > 128 * 1024) {
                throw new TypeError('tool run input is invalid');
            }
            const captured = await options.capture(input);
            const profile = policyProfile(captured.profile);
            const runId = options.generateId();
            const snapshotId = options.generateId();
            const snapshot = captured.registry.createSnapshot({
                id: snapshotId,
                facts: captured.initialFacts,
                enabledTools: captured.enabledTools
            });
            if (runs.size >= maxActiveRuns) {
                const oldest = runs.keys().next().value;
                if (oldest === undefined)
                    throw new ToolRuntimeConfigurationError('runtime_capacity_exceeded');
                removeRun(oldest);
            }
            runs.set(snapshotId, Object.freeze({
                profile, approvalTtlSeconds: captured.approvalTtlSeconds,
                runId, snapshot, initialFacts: captured.initialFacts,
                intent: captured.intent, refreshFacts: captured.refreshFacts
            }));
            options.onRunCaptured?.(runs.get(snapshotId));
            const timer = setTimeout(() => removeRun(snapshotId), runTtlMs);
            timer.unref?.();
            expiryTimers.set(snapshotId, timer);
            return Object.freeze({
                profile, runId, snapshotId,
                modelFunctions: Object.freeze(snapshot.modelTools.map(tool => tool.function)),
                promptAddition: captured.promptAddition ?? '',
                systemAddition: captured.systemAddition ?? ''
            });
        },
        async execute(input) {
            const run = runs.get(input.snapshotId);
            if (run === undefined)
                throw new ToolRuntimeConfigurationError('runtime_not_found');
            const outcome = await options.executor.execute({
                snapshot: run.snapshot,
                call: Object.freeze({
                    runId: run.runId,
                    callId: input.callId,
                    snapshotId: input.snapshotId,
                    requestedName: input.requestedName,
                    arguments: input.arguments
                }),
                profile: run.profile,
                initialFacts: run.initialFacts,
                intent: run.intent,
                refreshFacts: run.refreshFacts,
                ...(run.approvalTtlSeconds === undefined ? {} : { approvalTtlSeconds: run.approvalTtlSeconds }),
                ...(input.signal === undefined ? {} : { signal: input.signal })
            });
            if (outcome.kind === 'approval_required') {
                return Object.freeze({
                    toolName: outcome.toolName,
                    modelFeedback: approvalFeedback(outcome),
                    result: null,
                    finalize: true,
                    approvalRequired: true
                });
            }
            return Object.freeze({
                toolName: outcome.toolName,
                modelFeedback: stableFeedback(outcome.result),
                result: outcome.result,
                finalize: outcome.finalize || shouldFinalizeToolResult(outcome.result),
                approvalRequired: false
            });
        },
        finish(snapshotId, finishOptions = {}) {
            if (finishOptions.retainForApproval !== true)
                removeRun(snapshotId);
        }
    });
}
function runtimeId() {
    return randomUUID().replace(/-/g, '');
}
function identifier(value, label) {
    const text = typeof value === 'number' && Number.isSafeInteger(value)
        ? String(value)
        : typeof value === 'string' ? value : '';
    if (text === '' || text.length > 128 || /[\u0000-\u001f\u007f]/.test(text)) {
        throw new TypeError(`${label} is invalid`);
    }
    return text;
}
function finiteInteger(value, fallback, minimum, maximum) {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(Math.max(Math.trunc(value), minimum), maximum)
        : fallback;
}
function configText(config, key) {
    const value = config[key];
    return typeof value === 'string' ? value.trim() : '';
}
function configBoolean(config, key) {
    return config[key] === true;
}
function boundedIntentText(value) {
    const bytes = Buffer.from(value, 'utf8');
    if (bytes.byteLength <= 32 * 1024)
        return value;
    return bytes.subarray(0, 32 * 1024).toString('utf8').replace(/\uFFFD$/, '');
}
function legacyImageUrls(value) {
    if (!Array.isArray(value))
        return Object.freeze([]);
    return Object.freeze(value
        .filter((item) => typeof item === 'string' && item.length > 0 && item.length <= 4_096)
        .slice(0, 8));
}
function eventRecord(event) {
    if (event === null || typeof event !== 'object')
        throw new TypeError('Yunzai event is invalid');
    return event;
}
function role(value) {
    return value === 'owner' || value === 'admin' ? value : 'member';
}
function memberFromMap(members, userId) {
    return members.get(userId) ?? members.get(Number(userId));
}
function hostIdentifier(value) {
    if (!/^\d+$/.test(value))
        return value;
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) ? numeric : value;
}
function collectionHasIdentifier(collection, targetId, propertyNames) {
    if (collection instanceof Map) {
        return collection.has(targetId) || collection.has(hostIdentifier(targetId));
    }
    if (!Array.isArray(collection))
        return false;
    return collection.some(item => item !== null && typeof item === 'object' &&
        propertyNames.some(property => String(item[property] ?? '') === targetId));
}
async function groupFor(event, groupId) {
    if (String(event.group_id ?? '') === groupId && event.group !== undefined)
        return event.group;
    const group = await event.bot?.pickGroup?.(hostIdentifier(groupId));
    if (group === undefined || group === null)
        throw new Error('group unavailable');
    return group;
}
async function memberMap(event, groupId) {
    const group = await groupFor(event, groupId);
    const members = await group.getMemberMap?.();
    if (!(members instanceof Map))
        throw new Error('member map unavailable');
    return members;
}
async function sourceFor(options, event, masters) {
    const botId = identifier(options.getBotId(event), 'bot ID');
    const actorId = identifier(event.sender?.user_id ?? event.user_id, 'actor ID');
    const groupId = event.isGroup === true ? identifier(event.group_id, 'group ID') : null;
    let members = null;
    if (groupId !== null) {
        try {
            members = await memberMap(event, groupId);
        }
        catch { }
    }
    const actorMember = members === null ? undefined : memberFromMap(members, actorId);
    const botMember = members === null ? undefined : memberFromMap(members, botId);
    const actorRole = role(actorMember?.role ?? event.sender?.role);
    const botRole = groupId === null ? 'none' : role(botMember?.role);
    return {
        botId,
        actor: {
            userId: actorId,
            displayName: String(event.sender?.card ?? event.sender?.nickname ?? '').slice(0, 100),
            role: actorRole
        },
        channel: groupId === null
            ? { kind: 'private', botId, userId: actorId }
            : { kind: 'group', botId, groupId },
        scope: groupId === null
            ? { kind: 'private', userId: actorId }
            : configBoolean(options.config, 'groupMerge')
                ? { kind: 'group', groupId }
                : { kind: 'group_user', groupId, userId: actorId },
        botMasterIds: masters,
        botGroupRole: botRole,
        actorGroupRole: groupId === null ? 'none' : actorRole,
        lookupTarget: async (target, signal) => {
            if (signal.aborted)
                throw new DOMException('operation was aborted', 'AbortError');
            if (target.kind === 'none')
                return { exists: true, role: 'none' };
            if (target.kind === 'message') {
                return { exists: target.groupId === groupId && target.messageId !== '', role: 'none' };
            }
            if (target.kind === 'group') {
                if (target.groupId === groupId)
                    return { exists: true, role: 'none' };
                try {
                    const groups = await event.bot?.getGroupList?.() ?? event.bot?.gl;
                    const exists = collectionHasIdentifier(groups, target.groupId, ['group_id', 'groupId']);
                    return { exists, role: 'none' };
                }
                catch {
                    return { exists: false, role: 'none' };
                }
            }
            if (target.kind === 'private') {
                if (target.userId === actorId && groupId === null)
                    return { exists: true, role: 'none' };
                try {
                    const friends = await event.bot?.getFriendList?.() ?? event.bot?.fl;
                    const exists = collectionHasIdentifier(friends, target.userId, ['user_id', 'userId']);
                    return { exists, role: 'none' };
                }
                catch {
                    return { exists: false, role: 'none' };
                }
            }
            try {
                const targetMembers = await memberMap(event, target.groupId);
                const member = memberFromMap(targetMembers, target.userId);
                return { exists: member !== undefined, role: member?.role ?? 'none' };
            }
            catch {
                return { exists: false, role: 'none' };
            }
        }
    };
}
async function replyMessageId(event) {
    const direct = event.source?.message_id;
    if (direct !== undefined && direct !== null && String(direct) !== '')
        return String(direct);
    if (event.source?.seq === undefined || event.group?.getChatHistory === undefined)
        return null;
    try {
        const history = await event.group.getChatHistory(event.source.seq, 1);
        const message = Array.isArray(history) ? history.at(-1) : undefined;
        return message?.message_id === undefined ? null : String(message.message_id);
    }
    catch {
        return null;
    }
}
function mentions(event) {
    const values = [];
    const segments = Array.isArray(event.message) ? event.message : [];
    for (const segment of segments) {
        if (segment?.type !== 'at')
            continue;
        const value = segment.qq ?? segment.data?.qq;
        if ((typeof value === 'string' || typeof value === 'number') && String(value) !== 'all')
            values.push(value);
    }
    if (values.length === 0 && (typeof event.at === 'string' || typeof event.at === 'number'))
        values.push(event.at);
    return values.slice(0, 32);
}
function imageBackend(config) {
    const source = configText(config, 'imageSearchSource');
    if (source === 'tavily' || source === 'brave')
        return source;
    if (source === 'ikechan8370')
        return 'public';
    if (configText(config, 'tavilyApiKey') !== '')
        return 'tavily';
    if (configText(config, 'braveSearchApiKey') !== '')
        return 'brave';
    return 'public';
}
function searchBackend(config) {
    const source = configText(config, 'serpSource');
    if (source === 'tavily')
        return 'tavily';
    if (source === 'azure')
        return 'bing';
    return 'public';
}
function queryConfig(config) {
    return {
        searchSource: searchBackend(config), publicSearchSource: 'bing',
        tavilyApiKey: configText(config, 'tavilyApiKey'),
        bingApiKey: configText(config, 'azSerpKey'),
        amapKey: configText(config, 'amapKey'),
        amapApiBaseUrl: 'https://restapi.amap.com',
        githubApiBaseUrl: 'https://api.github.com',
        githubApiKey: configText(config, 'githubAPIKey'),
        imageSearchSource: imageBackend(config),
        braveSearchApiKey: configText(config, 'braveSearchApiKey'),
        extraUrl: configText(config, 'extraUrl')
    };
}
function throwIfAborted(signal) {
    if (signal.aborted)
        throw new DOMException('operation was aborted', 'AbortError');
}
function requireHostSuccess(value) {
    if (value === false)
        throw new Error('host capability reported failure');
}
async function messageTarget(event, target) {
    if (target.kind === 'group')
        return await event.bot.pickGroup(hostIdentifier(target.groupId));
    if (target.kind === 'private')
        return await event.bot.pickFriend(hostIdentifier(target.userId));
    throw new TypeError('message target is invalid');
}
function resourceValue(resource) {
    if (resource.kind === 'buffer') {
        return Buffer.isBuffer(resource.data)
            ? resource.data
            : Buffer.from(resource.data.buffer, resource.data.byteOffset, resource.data.byteLength);
    }
    return resource.kind === 'remote_url' ? resource.url : resource.path;
}
function magicSegment(segment, type, value) {
    const factory = segment[type];
    if (typeof factory === 'function') {
        return Reflect.apply(factory, segment, value === undefined ? [] : [value]);
    }
    return { type, data: {} };
}
function qqCapabilities(event, segment) {
    const send = async (target, message, signal) => {
        throwIfAborted(signal);
        const receiver = await messageTarget(event, target);
        requireHostSuccess(await receiver.sendMsg(message));
        throwIfAborted(signal);
    };
    return {
        sendText: async (target, text, signal) => send(target, text, signal),
        sendImage: async (target, resource, signal) => send(target, segment.image(resourceValue(resource)), signal),
        sendAudio: async (target, resource, signal) => send(target, segment.record(resourceValue(resource)), signal),
        sendVideo: async (target, resource, signal) => send(target, segment.video(resourceValue(resource)), signal),
        sendMusic: async (target, music, signal) => send(target, segment.music(music.provider, music.id), signal),
        sendDice: async (target, signal) => send(target, magicSegment(segment, 'dice'), signal),
        sendRps: async (target, value, signal) => send(target, magicSegment(segment, 'rps', value), signal)
    };
}
function legacyMediaResource(value, mimeType) {
    const record = value !== null && typeof value === 'object' ? value : {};
    const file = record.file ?? record.data?.file ?? value;
    if (file instanceof Uint8Array) {
        return Object.freeze({ kind: 'buffer', data: file, mimeType, byteLength: file.byteLength });
    }
    if (typeof file !== 'string' || file === '' || file.length > 12 * 1024 * 1024) {
        throw new TypeError('legacy media segment is invalid');
    }
    if (file.startsWith('base64://')) {
        const data = Buffer.from(file.slice('base64://'.length), 'base64');
        return Object.freeze({ kind: 'buffer', data, mimeType, byteLength: data.byteLength });
    }
    const dataUrl = /^data:([^;,]{1,128});base64,([A-Za-z0-9+/=]+)$/i.exec(file);
    if (dataUrl !== null) {
        const data = Buffer.from(dataUrl[2], 'base64');
        return Object.freeze({ kind: 'buffer', data, mimeType: dataUrl[1], byteLength: data.byteLength });
    }
    if (/^https?:\/\//i.test(file)) {
        if (file.length > 4_096)
            throw new TypeError('legacy media URL is invalid');
        return Object.freeze({ kind: 'remote_url', url: file, mimeType, byteLength: 0 });
    }
    const path = file.replace(/^file:\/\//, '');
    if (path === '' || path.length > 4_096 || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
        throw new TypeError('legacy media path is invalid');
    }
    return Object.freeze({ kind: 'local_path', path, mimeType, byteLength: 0 });
}
function capturedImageResource(messages) {
    const queue = [...messages];
    const visited = new Set();
    let inspected = 0;
    while (queue.length > 0 && inspected < 256) {
        inspected += 1;
        const value = queue.shift();
        if (Array.isArray(value)) {
            queue.push(...value.slice(0, 64));
            continue;
        }
        if (value === null || typeof value !== 'object')
            continue;
        if (visited.has(value))
            continue;
        visited.add(value);
        const record = value;
        const data = record.data !== null && typeof record.data === 'object' ? record.data : {};
        if (record.type === 'image' || data.type === 'image') {
            return legacyMediaResource(record.file === undefined ? data.file : record.file, 'image/png');
        }
        if (record.message !== undefined)
            queue.push(record.message);
        if (record.data !== undefined)
            queue.push(record.data);
    }
    throw new Error('external plugin did not return a captured image');
}
const blockedExternalCapability = /send|recall|delete|remove|set|mute|kick|ban|leave|add|upload|forward|share|poke|like/i;
function captureExternalMessage(messages, message) {
    if (messages.length >= 32)
        throw new Error('external plugin output limit exceeded');
    messages.push(message);
    return Object.freeze({ message_id: `groupmate-captured-${messages.length}` });
}
function isPromiseLike(value) {
    return value !== null && typeof value === 'object' &&
        typeof value.then === 'function';
}
function externalReceiverFacade(receiver, messages) {
    if (receiver === null || typeof receiver !== 'object')
        return receiver;
    return new Proxy(receiver, {
        get(target, property) {
            const name = String(property);
            const value = Reflect.get(target, property, target);
            if (name === 'sendMsg' || name === 'sendMessage') {
                return async (message) => captureExternalMessage(messages, message);
            }
            if (name === 'pickMember' && typeof value === 'function') {
                return (...args) => {
                    const selected = Reflect.apply(value, target, args);
                    return isPromiseLike(selected)
                        ? selected.then(item => externalReceiverFacade(item, messages))
                        : externalReceiverFacade(selected, messages);
                };
            }
            if (typeof value === 'function' && blockedExternalCapability.test(name)) {
                return async () => { throw new Error('external plugin capability is blocked'); };
            }
            return typeof value === 'function' ? value.bind(target) : value;
        },
        set() {
            throw new Error('external plugin capability is blocked');
        }
    });
}
function externalBotFacade(bot, messages) {
    if (bot === null || typeof bot !== 'object')
        return bot;
    return new Proxy(bot, {
        get(target, property) {
            const name = String(property);
            const value = Reflect.get(target, property, target);
            if (name === 'sendGroupMsg' || name === 'sendPrivateMsg') {
                return async (...args) => captureExternalMessage(messages, args[1]);
            }
            if (name === 'sendMsg' || name === 'sendMessage') {
                return async (message) => captureExternalMessage(messages, message);
            }
            if (['pickGroup', 'pickFriend', 'pickMember'].includes(name) && typeof value === 'function') {
                return (...args) => {
                    const selected = Reflect.apply(value, target, args);
                    return isPromiseLike(selected)
                        ? selected.then(item => externalReceiverFacade(item, messages))
                        : externalReceiverFacade(selected, messages);
                };
            }
            if (typeof value === 'function' && blockedExternalCapability.test(name)) {
                return async () => { throw new Error('external plugin capability is blocked'); };
            }
            return typeof value === 'function' ? value.bind(target) : value;
        },
        set() {
            throw new Error('external plugin capability is blocked');
        }
    });
}
export function createExternalPluginEventFacade(input) {
    const event = eventRecord(input);
    const messages = [];
    const captured = Object.assign(Object.create(Object.getPrototypeOf(event)), event);
    captured.bot = externalBotFacade(event.bot, messages);
    captured.group = externalReceiverFacade(event.group, messages);
    captured.friend = externalReceiverFacade(event.friend, messages);
    captured.member = externalReceiverFacade(event.member, messages);
    captured.reply = async (message) => captureExternalMessage(messages, message);
    return Object.freeze({ event: captured, messages });
}
async function importFirst(specifiers) {
    for (const specifier of specifiers) {
        try {
            return await import(specifier);
        }
        catch { }
    }
    throw new Error('external plugin is unavailable');
}
async function generateWithApPlugin(event, prompt, signal) {
    throwIfAborted(signal);
    const captured = createExternalPluginEventFacade(event);
    if (captured.event.at === captured.event.bot?.uin)
        captured.event.at = null;
    captured.event.atBot = false;
    captured.event.msg = `#绘图${prompt}`;
    const module = await importFirst([
        new URL('../../../../ap-plugin/apps/aiPainting.js', import.meta.url).href,
        new URL('../../../../ap-plugin/apps/ai_painting.js', import.meta.url).href
    ]);
    const Painting = module.Ai_Painting;
    if (typeof Painting !== 'function')
        throw new Error('ap-plugin entry is invalid');
    const painting = new Painting(captured.event);
    if (typeof painting.aiPainting !== 'function')
        throw new Error('ap-plugin capability is invalid');
    await painting.aiPainting(captured.event);
    throwIfAborted(signal);
    return capturedImageResource(captured.messages);
}
async function queryWithMiaoPlugin(event, input, signal) {
    throwIfAborted(signal);
    const captured = createExternalPluginEventFacade(event);
    if (captured.event.at === captured.event.bot?.uin)
        captured.event.at = null;
    captured.event.atBot = false;
    captured.event.user_id = hostIdentifier(input.userId);
    captured.event.isSr = input.game === 'star_rail';
    const prefix = input.game === 'star_rail' ? '*' : '#';
    if (input.character !== '') {
        captured.event.original_msg = `${prefix}${input.character}面板${input.uid}`;
        const module = await importFirst([
            new URL('../../../../miao-plugin/apps/profile/ProfileDetail.js', import.meta.url).href
        ]);
        if (typeof module.default?.detail !== 'function')
            throw new Error('miao-plugin detail capability is invalid');
        await module.default.detail(captured.event);
    }
    else {
        captured.event.msg = `${prefix}面板${input.uid}`;
        const module = await importFirst([
            new URL('../../../../miao-plugin/apps/profile/ProfileList.js', import.meta.url).href
        ]);
        if (typeof module.default?.render !== 'function')
            throw new Error('miao-plugin list capability is invalid');
        await module.default.render(captured.event);
    }
    throwIfAborted(signal);
    return capturedImageResource(captured.messages);
}
function pictureProcessor(policyFetch, configuredBaseUrl) {
    if (configuredBaseUrl === '')
        return undefined;
    let baseUrl;
    try {
        baseUrl = new URL(configuredBaseUrl);
    }
    catch {
        return undefined;
    }
    if (baseUrl.protocol !== 'https:' || baseUrl.username !== '' || baseUrl.password !== '' ||
        baseUrl.search !== '' || baseUrl.hash !== '' || (baseUrl.pathname !== '' && baseUrl.pathname !== '/')) {
        return undefined;
    }
    const port = baseUrl.port === '' ? 443 : Number(baseUrl.port);
    const policy = Object.freeze({
        kind: 'fixed_hosts',
        hosts: Object.freeze([Object.freeze({
                hostname: baseUrl.hostname,
                port,
                pathPrefixes: Object.freeze(['/image2hed', '/image2Scribble'])
            })]),
        maxBytes: 8 * 1024 * 1024,
        allowedContentTypes: Object.freeze(['image/*', 'text/plain', 'application/json'])
    });
    return async (resource, type, signal) => {
        if (resource.kind !== 'buffer')
            throw new TypeError('picture processor requires buffered input');
        const boundary = `groupmate-${randomBytes(8).toString('hex')}`;
        const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image"\r\n` +
            `Content-Type: ${resource.mimeType}\r\n\r\n`);
        const body = Buffer.concat([
            prefix, Buffer.from(resource.data), Buffer.from(`\r\n--${boundary}--\r\n`)
        ]);
        const endpoint = type === 'scribble' ? '/image2Scribble' : '/image2hed';
        const response = await policyFetch.request({
            url: `${baseUrl.origin}${endpoint}`, policy, timeoutMs: 20_000, signal,
            method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body
        });
        if (response.status < 200 || response.status >= 300)
            throw new Error('picture processing failed');
        if (response.contentType.startsWith('image/')) {
            return Object.freeze({
                kind: 'buffer', data: response.body,
                mimeType: response.contentType, byteLength: response.body.byteLength
            });
        }
        const text = Buffer.from(response.body).toString('utf8').trim();
        let candidate = text;
        if (response.contentType === 'application/json') {
            const parsed = JSON.parse(text);
            candidate = typeof parsed === 'string' ? parsed : parsed.url ?? parsed.path ?? parsed.result;
        }
        if (typeof candidate !== 'string' || candidate === '' || candidate.length > 4_096) {
            throw new Error('picture processing result is invalid');
        }
        const outputUrl = new URL(candidate, `${baseUrl.origin}/`);
        if (outputUrl.origin !== baseUrl.origin || outputUrl.protocol !== 'https:') {
            throw new Error('picture processing result origin is invalid');
        }
        return Object.freeze({
            kind: 'remote_url', url: outputUrl.href,
            mimeType: 'image/png', byteLength: 0
        });
    };
}
function managementCapabilities(event) {
    return {
        muteMember: async (target, seconds, signal) => {
            throwIfAborted(signal);
            requireHostSuccess(await (await groupFor(event, target.groupId)).muteMember(hostIdentifier(target.userId), seconds));
        },
        kickMember: async (target, signal) => {
            throwIfAborted(signal);
            requireHostSuccess(await (await groupFor(event, target.groupId)).kickMember(hostIdentifier(target.userId)));
        },
        setCard: async (target, card, signal) => {
            throwIfAborted(signal);
            requireHostSuccess(await (await groupFor(event, target.groupId)).setCard(hostIdentifier(target.userId), card));
        },
        setTitle: async (target, title, signal) => {
            throwIfAborted(signal);
            requireHostSuccess(await (await groupFor(event, target.groupId)).setTitle(hostIdentifier(target.userId), title));
        },
        recallMessage: async (target, signal) => {
            throwIfAborted(signal);
            requireHostSuccess(await (await groupFor(event, target.groupId)).recallMsg(target.messageId));
        },
        setEssence: async (target, enabled, signal) => {
            throwIfAborted(signal);
            if (enabled)
                requireHostSuccess(await event.bot.setEssenceMessage(target.messageId));
            else
                requireHostSuccess(await event.bot.removeEssenceMessage(target.messageId));
        }
    };
}
async function resolveBilibiliVideo(policyFetch, id, download, signal) {
    const policy = {
        kind: 'fixed_hosts',
        hosts: [{ hostname: 'api.bilibili.com', port: 443, pathPrefixes: ['/x/web-interface/view', '/x/player/playurl'] }],
        maxBytes: 256 * 1024,
        allowedContentTypes: ['application/json']
    };
    const view = await policyFetch.request({
        url: `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(id)}`,
        policy, timeoutMs: 10_000, signal,
        headers: { referer: 'https://www.bilibili.com', 'user-agent': 'GroupMate/0.1' }
    });
    const parsed = JSON.parse(Buffer.from(view.body).toString('utf8'));
    const data = parsed.data;
    if (view.status < 200 || view.status >= 300 || data === null || typeof data !== 'object') {
        throw new Error('video unavailable');
    }
    const title = String(data.title ?? '').replace(/<[^>]+>/g, '').slice(0, 300);
    const author = String(data.owner?.name ?? '').slice(0, 100);
    const url = `https://www.bilibili.com/video/${encodeURIComponent(id)}`;
    const shareText = `${title}\nUP主：${author}\n${url}\n${String(data.desc ?? '').slice(0, 1_000)}`.trim();
    if (!download)
        return Object.freeze({ id, shareText });
    const play = await policyFetch.request({
        url: `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(id)}&cid=${encodeURIComponent(String(data.cid ?? ''))}`,
        policy, timeoutMs: 10_000, signal,
        headers: { referer: 'https://www.bilibili.com', 'user-agent': 'GroupMate/0.1' }
    });
    const playData = JSON.parse(Buffer.from(play.body).toString('utf8'));
    const videoUrl = playData.data?.durl?.[0]?.url;
    return typeof videoUrl === 'string' && videoUrl !== ''
        ? Object.freeze({ id, shareText, videoUrl })
        : Object.freeze({ id, shareText });
}
async function currentMembers(event, groupId, signal) {
    throwIfAborted(signal);
    const members = await memberMap(event, groupId);
    const result = new Map();
    for (const [key, value] of members) {
        const userId = String(value.user_id ?? key);
        result.set(userId, {
            userId,
            ...(value.nickname === undefined ? {} : { nickname: String(value.nickname) }),
            ...(value.card === undefined ? {} : { card: String(value.card) }),
            role: role(value.role),
            ...(value.title === undefined ? {} : { title: String(value.title) })
        });
    }
    return result;
}
function visibleServices(options, event, policyFetch) {
    const downloadVideo = configBoolean(options.config, 'enableToolVideoDownload');
    const ttsAvailable = options.synthesizeAudio !== undefined && [
        'ttsSpace', 'azureTTSKey', 'voicevoxSpace'
    ].some(key => configText(options.config, key) !== '');
    const processImage = options.processImage ?? pictureProcessor(policyFetch, configText(options.config, 'extraUrl'));
    const privateSendEnabled = configBoolean(options.config, 'enableToolPrivateSend');
    const crossGroupSendEnabled = configBoolean(options.config, 'enableToolCrossGroupSend');
    return {
        policyFetch,
        qq: qqCapabilities(event, options.segment()),
        generateImage: async (prompt, signal) => {
            return options.generateImage === undefined
                ? generateWithApPlugin(event, prompt, signal)
                : options.generateImage(event, prompt, signal);
        },
        processImage: processImage ?? (async () => { throw new Error('picture processing unavailable'); }),
        synthesizeAudio: async (text, voice, signal) => {
            if (options.synthesizeAudio === undefined)
                throw new Error('TTS unavailable');
            return options.synthesizeAudio(event, text, voice, signal);
        },
        resolveVideo: async (id, signal) => resolveBilibiliVideo(policyFetch, id, downloadVideo, signal),
        drawingAvailable: true,
        pictureProcessingAvailable: processImage !== undefined,
        ttsAvailable,
        videoDownloadEnabled: downloadVideo,
        videoMaxBytes: finiteInteger(options.config.toolVideoMaxMB, 8, 1, 8) * 1024 * 1024,
        canSendCrossChannel: target => target.kind === 'private'
            ? privateSendEnabled
            : crossGroupSendEnabled
    };
}
function safeAudit(logger) {
    return {
        emit(event) {
            logger?.info?.(Object.freeze({ event: 'groupmate.tool.audit', ...event }));
        }
    };
}
export function toolResourceFromLegacySegment(value) {
    return legacyMediaResource(value, 'audio/mpeg');
}
export function createYunzaiToolRuntimeBridge(options) {
    const policyFetch = options.policyFetch ?? new PolicyFetch();
    const productionRuns = new Map();
    const controls = new Map();
    const approvalOwners = new Map();
    const pendingCalls = new InMemoryPendingCallStore({
        now: Date.now, maxEntries: 128, maxEntryBytes: 16 * 1024,
        maxTotalBytes: 512 * 1024, ttlMs: 5 * 60 * 1_000
    });
    const approvalRouter = {
        create: async (record, ttlSeconds) => {
            const owner = [...controls.values()].find(item => item.botIdHash === record.botIdHash);
            if (owner === undefined)
                throw new ToolRuntimeConfigurationError('runtime_not_found');
            await owner.approvals.create(record, ttlSeconds);
            approvalOwners.set(record.tokenHash, owner.botId);
        },
        get: async (tokenHash) => {
            const ownerId = approvalOwners.get(tokenHash);
            if (ownerId === undefined)
                return null;
            const record = await (controls.get(ownerId)?.approvals.get(tokenHash) ?? null);
            if (record === null)
                approvalOwners.delete(tokenHash);
            return record;
        },
        consume: async (tokenHash, expectedRawVersion) => {
            const ownerId = approvalOwners.get(tokenHash);
            if (ownerId === undefined)
                return null;
            const record = await (controls.get(ownerId)?.approvals.consume(tokenHash, expectedRawVersion) ?? null);
            approvalOwners.delete(tokenHash);
            return record;
        }
    };
    const ensureControl = (botId) => {
        const existing = controls.get(botId);
        if (existing !== undefined)
            return existing;
        const botIdHash = sha256ApprovalValue(botId);
        const approvals = new RedisApprovalStore({ client: options.redis, botIdHash });
        const executor = new ToolExecutor({
            policy: new ToolPolicyEngine(),
            approvalStore: approvalRouter,
            pendingCalls,
            idempotencyStore: new RedisIdempotencyStore({ client: options.redis, botIdHash }),
            audit: safeAudit(options.logger),
            generateId: runtimeId,
            generateToken: () => randomBytes(18).toString('base64url'),
            hash: sha256ApprovalValue,
            now: () => new Date(),
            approvalTtlSeconds: 120
        });
        const created = Object.freeze({ botId, botIdHash, executor, approvals });
        controls.set(botId, created);
        return created;
    };
    const executorRouter = {
        execute: async (request) => ensureControl(request.initialFacts.botId).executor.execute(request)
    };
    const approvalService = new ApprovalCommandService({
        approvals: approvalRouter,
        pendingCalls,
        executor: executorRouter,
        hash: sha256ApprovalValue,
        now: () => new Date(),
        bindEvent: async (rawEvent) => {
            const event = eventRecord(rawEvent);
            const currentBotId = identifier(options.getBotId(event), 'bot ID');
            const actorId = identifier(event.sender?.user_id ?? event.user_id, 'actor ID');
            const masters = (await options.getMasterIds()).map(String);
            const channel = event.isGroup === true
                ? `group:${identifier(event.group_id, 'group ID')}`
                : `private:${actorId}`;
            return Object.freeze({
                botIdHash: sha256ApprovalValue(currentBotId),
                actorIdHash: sha256ApprovalValue(actorId),
                channelHash: sha256ApprovalValue(channel),
                isBotMaster: masters.includes(actorId)
            });
        },
        resolveRuntime: async (record, _pending, _event, signal) => {
            throwIfAborted(signal);
            const run = productionRuns.get(record.snapshotId);
            if (run === undefined)
                throw new ToolRuntimeConfigurationError('runtime_not_found');
            return run;
        }
    });
    globalThis.groupmateApprovalService = approvalService;
    const bridge = createLegacyToolRuntimeBridge({
        generateId: runtimeId,
        executor: executorRouter,
        onRunCaptured: run => {
            productionRuns.set(run.snapshot.id, Object.freeze({
                snapshot: run.snapshot,
                initialFacts: run.initialFacts,
                refreshFacts: run.refreshFacts
            }));
            while (productionRuns.size > 64) {
                const oldest = productionRuns.keys().next().value;
                if (oldest === undefined)
                    break;
                productionRuns.delete(oldest);
            }
        },
        onRunExpired: snapshotId => productionRuns.delete(snapshotId),
        capture: async (input) => {
            const event = eventRecord(input.event);
            const masters = await options.getMasterIds();
            const source = await sourceFor(options, event, masters);
            const initialFacts = await resolveToolRuntimeFacts(source, { kind: 'none' });
            ensureControl(initialFacts.botId);
            const refreshFacts = async (target, signal) => {
                const currentSource = await sourceFor(options, event, await options.getMasterIds());
                return resolveToolRuntimeFacts(currentSource, target, signal);
            };
            const visibleToolServices = visibleServices(options, event, policyFetch);
            const query = createQueryToolRuntime({
                policyFetch,
                config: queryConfig(options.config),
                currentGroupMembers: async (groupId, signal) => currentMembers(event, groupId, signal),
                queryGame: async (gameInput, signal) => {
                    return options.queryGame === undefined
                        ? queryWithMiaoPlugin(event, gameInput, signal)
                        : options.queryGame(event, gameInput, signal);
                },
                sendGameImage: async (resource, target, signal) => {
                    await visibleToolServices.qq.sendImage(target, resource, signal);
                }
            });
            const visible = createVisibleToolDefinitions(visibleToolServices);
            const management = createManagementToolDefinitions(managementCapabilities(event));
            const definitions = Object.freeze([...query.definitions, ...visible, ...management]);
            const registry = new ToolRegistry(definitions);
            const enabledTools = definitions
                .filter(definition => {
                if (definition.name === 'draw')
                    return visibleToolServices.drawingAvailable;
                if (definition.name === 'processPicture')
                    return visibleToolServices.pictureProcessingAvailable;
                if (definition.name === 'sendAudioMessage') {
                    return options.synthesizeAudio !== undefined && [
                        'ttsSpace', 'azureTTSKey', 'voicevoxSpace'
                    ].some(key => configText(options.config, key) !== '');
                }
                return true;
            })
                .map(definition => definition.name);
            const replyId = await replyMessageId(event);
            const images = legacyImageUrls(options.getImages === undefined ? undefined : await options.getImages(event));
            const intentText = boundedIntentText(typeof event.groupmateCurrentRequestText === 'string'
                ? event.groupmateCurrentRequestText
                : input.prompt);
            return {
                profile: options.config.toolPolicyProfile ?? 'compatible',
                approvalTtlSeconds: finiteInteger(options.config.toolApprovalTtlSeconds, 120, 30, 300),
                registry,
                enabledTools,
                initialFacts,
                refreshFacts,
                intent: extractIntentEvidence({
                    text: intentText,
                    mentions: mentions(event),
                    reply: replyId === null ? null : { messageId: replyId },
                    ...(event.message_id === undefined ? {} : { currentMessageId: event.message_id })
                }),
                promptAddition: images.length === 0 ? '' : `\nthe url of the picture(s) above: ${images.join(', ')}`,
                systemAddition: replyId === null
                    ? '\nNever manage the current request message itself.\n'
                    : `\nthe current request is replying to messageId ${replyId}. Only manage that message when explicitly requested.\nNever manage the current request message itself.\n`
            };
        }
    });
    return bridge;
}
