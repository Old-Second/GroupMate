import { parseAgentEvent } from '../agent/contracts/event.js';
import { parseFrozenObservationPolicy } from '../agent/run/run-observation.js';
import { RUN_REF_PATTERN } from '../agent/run/run-reference.js';
import { plainTextPart } from './presentation/text-presentation.js';
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
function progressRequestKind(value) {
    if (value !== 'ordinary_chat' && value !== 'proactive_chat' &&
        value !== 'recovered_legacy_plain_text') {
        throw new TypeError('progress attachment is invalid');
    }
    return value;
}
async function dismissIndicatorBestEffort(indicator, reason) {
    try {
        await indicator?.dismiss(reason);
    }
    catch {
        // Pending recall cannot suppress progress or poison a later queue task.
    }
}
export function progressResumeStateFromEvents(rawEvents) {
    const seenEventIds = new Set();
    const seenStages = new Set();
    for (const rawEvent of rawEvents) {
        let event;
        try {
            event = parseAgentEvent(rawEvent);
        }
        catch {
            continue;
        }
        if (seenEventIds.has(event.eventId))
            continue;
        seenEventIds.add(event.eventId);
        const progress = progressFor(event);
        if (progress !== null && seenStages.size < MAX_PROGRESS_MESSAGES) {
            seenStages.add(progress.key);
        }
    }
    const stages = Object.freeze([...seenStages]);
    return Object.freeze({
        // A definite host rejection may have caused two physical deliveries. The
        // checkpoint deliberately persists no outbound receipts, so recovery
        // reserves the worst case for every historical stage.
        attempts: Math.min(MAX_PROGRESS_MESSAGES, stages.length * 2),
        seenStages: stages
    });
}
export class RunProgressPresenter {
    #states = new Map();
    #onDeliveryFailure;
    #onAttachment;
    constructor(options = {}) {
        this.#onDeliveryFailure = options.onDeliveryFailure;
        this.#onAttachment = options.onAttachment;
    }
    attach(input) {
        if (typeof input.runId !== 'string' || input.runId.length === 0 || input.runId.length > 128 ||
            typeof input.runRef !== 'string' || !RUN_REF_PATTERN.test(input.runRef)) {
            throw new TypeError('progress attachment is invalid');
        }
        const requestKind = progressRequestKind(input.requestKind);
        if (!Number.isSafeInteger(input.resume.attempts) || input.resume.attempts < 0 ||
            input.resume.attempts > MAX_PROGRESS_MESSAGES || !Array.isArray(input.resume.seenStages) ||
            input.resume.seenStages.length > MAX_PROGRESS_MESSAGES ||
            input.resume.seenStages.some(stage => typeof stage !== 'string' ||
                !stage.startsWith('tool_started:') || stage.length > 256) ||
            new Set(input.resume.seenStages).size !== input.resume.seenStages.length) {
            throw new TypeError('progress resume state is invalid');
        }
        const observationPolicy = parseFrozenObservationPolicy(input.observationPolicy);
        const resume = Object.freeze({
            attempts: input.resume.attempts,
            seenStages: Object.freeze([...input.resume.seenStages])
        });
        const state = {
            runId: input.runId,
            runRef: input.runRef,
            requestKind,
            observationPolicy,
            outbound: input.outbound,
            indicator: input.indicator,
            seenEventIds: new Set(),
            seenStages: new Set(resume.seenStages),
            attempts: resume.attempts,
            terminal: false,
            queue: Promise.resolve()
        };
        this.#states.set(input.runId, state);
        try {
            this.#onAttachment?.(Object.freeze({
                runId: state.runId,
                runRef: state.runRef,
                requestKind: state.requestKind,
                observationPolicy,
                resume
            }));
        }
        catch {
            // A safe observation seam cannot affect presentation.
        }
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
        if (event.type === 'run.paused' || terminalEvent(event)) {
            state.terminal = true;
            const reason = event.type === 'run.paused' ? 'paused' : 'terminal';
            state.queue = state.queue.then(async () => {
                await dismissIndicatorBestEffort(state.indicator, reason);
            });
            return;
        }
        if (state.terminal || state.attempts >= MAX_PROGRESS_MESSAGES)
            return;
        const progress = progressFor(event);
        if (progress === null || state.seenStages.has(progress.key))
            return;
        state.seenStages.add(progress.key);
        state.attempts += 1;
        state.queue = state.queue.then(async () => {
            await dismissIndicatorBestEffort(state.indicator, 'progress');
            let resultCode = 'no_result';
            try {
                let final = await state.outbound.deliver(plainTextPart(progress.text), 1);
                if (final.kind === 'failed_definite' && final.code === 'host_rejected' &&
                    state.attempts < MAX_PROGRESS_MESSAGES) {
                    state.attempts += 1;
                    final = await state.outbound.deliver(plainTextPart(progress.text), 2);
                }
                if (final?.kind === 'sent')
                    return;
                resultCode = final?.kind ?? resultCode;
            }
            catch {
                resultCode = 'exception';
            }
            this.#reportFailure(state, event, resultCode);
        });
    }
    async drain(runId) {
        await (this.#states.get(runId)?.queue ?? Promise.resolve());
    }
    detach(runId) {
        this.#states.delete(runId);
    }
    #reportFailure(state, event, resultCode) {
        try {
            this.#onDeliveryFailure?.(Object.freeze({
                event: 'run.progress.delivery_failed',
                runRef: state.runRef,
                sequence: event.sequence,
                eventType: event.type,
                resultCode
            }));
        }
        catch {
            // Logging cannot affect a run or another progress delivery.
        }
    }
}
