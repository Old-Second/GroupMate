import { createHash } from 'node:crypto';
import { parseAgentEvent } from '../agent/contracts/event.js';
const MAX_PROGRESS_MESSAGES = 5;
const MAX_PROGRESS_CODE_POINTS = 200;
const TOOL_PROGRESS = Object.freeze({
    website: '正在读取网页',
    weather: '正在查询天气',
    github: '正在查询 GitHub',
    queryUserinfo: '正在查询群成员信息',
    sendPicture: '正在处理图片',
    musicQuery: '正在查询音乐',
    videoQuery: '正在查询视频',
    imageCaption: '正在理解图片',
    imageSearch: '正在搜索图片',
    processPicture: '正在处理图片'
});
function runReference(runId) {
    return createHash('sha256').update(runId).digest('hex').slice(0, 16);
}
function normalizedProgress(text) {
    return [...text.normalize('NFC').trim()].slice(0, MAX_PROGRESS_CODE_POINTS).join('');
}
function progressFor(event) {
    if (event.type !== 'tool.started' && event.type !== 'run.progress')
        return null;
    if (event.type === 'run.progress' && event.payload.stage !== 'tool_started')
        return null;
    const toolName = typeof event.payload.toolName === 'string' &&
        /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(event.payload.toolName)
        ? event.payload.toolName
        : 'unknown';
    const text = normalizedProgress(TOOL_PROGRESS[toolName] ?? '正在执行任务步骤');
    return text.length === 0 ? null : Object.freeze({
        key: `tool_started:${text}`,
        text
    });
}
function terminalEvent(event) {
    return event.type === 'run.completed' || event.type === 'run.failed' ||
        event.type === 'run.cancelled';
}
export class RunProgressPresenter {
    #states = new Map();
    #onDeliveryFailure;
    constructor(options = {}) {
        this.#onDeliveryFailure = options.onDeliveryFailure;
    }
    attach(runId, delivery, persistedEvents = []) {
        if (typeof runId !== 'string' || runId.length === 0 || runId.length > 128 ||
            typeof delivery !== 'function') {
            throw new TypeError('progress attachment is invalid');
        }
        const state = this.#states.get(runId) ?? {
            delivery,
            seenEventIds: new Set(),
            seenStages: new Set(),
            attempts: 0,
            terminal: false,
            queue: Promise.resolve()
        };
        state.delivery = delivery;
        for (const rawEvent of persistedEvents) {
            let event;
            try {
                event = parseAgentEvent(rawEvent);
            }
            catch {
                continue;
            }
            if (event.runId !== runId)
                continue;
            state.seenEventIds.add(event.eventId);
            const progress = progressFor(event);
            if (progress !== null && !state.seenStages.has(progress.key)) {
                state.seenStages.add(progress.key);
                state.attempts += 1;
            }
            if (terminalEvent(event))
                state.terminal = true;
        }
        this.#states.set(runId, state);
    }
    handle(rawEvent) {
        let event;
        try {
            event = parseAgentEvent(rawEvent);
        }
        catch {
            return;
        }
        const state = this.#states.get(event.runId);
        if (state === undefined || state.seenEventIds.has(event.eventId))
            return;
        state.seenEventIds.add(event.eventId);
        if (terminalEvent(event)) {
            state.terminal = true;
            return;
        }
        if (state.terminal || state.attempts >= MAX_PROGRESS_MESSAGES)
            return;
        const progress = progressFor(event);
        if (progress === null || state.seenStages.has(progress.key))
            return;
        state.seenStages.add(progress.key);
        state.attempts += 1;
        const delivery = state.delivery;
        state.queue = state.queue.then(async () => {
            try {
                await delivery(progress.text);
            }
            catch {
                this.#reportFailure(event);
            }
        });
    }
    async drain(runId) {
        await (this.#states.get(runId)?.queue ?? Promise.resolve());
    }
    detach(runId) {
        this.#states.delete(runId);
    }
    #reportFailure(event) {
        try {
            this.#onDeliveryFailure?.(Object.freeze({
                event: 'run.progress.delivery_failed',
                runRef: runReference(event.runId),
                sequence: event.sequence,
                eventType: event.type
            }));
        }
        catch {
            // Logging cannot affect a run or another progress delivery.
        }
    }
}
