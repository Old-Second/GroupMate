import { parseAgentEvent } from '../agent/contracts/event.js';
import { parseFrozenObservationPolicy } from '../agent/run/run-observation.js';
import { RUN_REF_PATTERN } from '../agent/run/run-reference.js';
import { plainTextPart } from './presentation/text-presentation.js';
import { createPresentationObservationId, createProgressPresentationReducerInput, parseObservationEvent } from './observability/observation-event.js';
const MAX_PROGRESS_MESSAGES = 5;
const MAX_PROGRESS_DELIVERY_ATTEMPTS = MAX_PROGRESS_MESSAGES * 2;
const MAX_PROGRESS_CODE_POINTS = 200;
const OCCURRENCE_ID = /^(?:0|[1-9]\d{0,9}):(?:0|[1-9]\d{0,2})$/;
const CALL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const TOOL_PROGRESS = Object.freeze({
    search: '正在搜索网络',
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
        TOOL_NAME.test(event.payload.toolName)
        ? event.payload.toolName
        : 'unknown';
    const text = normalizedProgress(TOOL_PROGRESS[toolName] ?? '正在执行任务步骤');
    const occurrenceId = typeof event.payload.occurrenceId === 'string' &&
        OCCURRENCE_ID.test(event.payload.occurrenceId)
        ? event.payload.occurrenceId
        : null;
    const callId = typeof event.payload.callId === 'string' && CALL_ID.test(event.payload.callId)
        ? event.payload.callId
        : null;
    return text.length === 0 ? null : Object.freeze({
        key: occurrenceId !== null
            ? `tool_started:${occurrenceId}`
            : callId !== null
                ? `tool_started:call:${callId}`
                : `tool_started:tool:${toolName}`,
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
        attempts: Math.min(MAX_PROGRESS_DELIVERY_ATTEMPTS, stages.length * 2),
        seenStages: stages
    });
}
export class RunProgressPresenter {
    #states = new Map();
    #onDeliveryFailure;
    #onAttachment;
    #publishObservation;
    #monotonicNow;
    constructor(options = {}) {
        this.#onDeliveryFailure = options.onDeliveryFailure;
        this.#onAttachment = options.onAttachment;
        this.#publishObservation = options.publishObservation;
        this.#monotonicNow = options.monotonicNow ?? (() => Math.trunc(performance.now()));
    }
    attach(input) {
        if (typeof input.runId !== 'string' || input.runId.length === 0 || input.runId.length > 128 ||
            typeof input.runRef !== 'string' || !RUN_REF_PATTERN.test(input.runRef)) {
            throw new TypeError('progress attachment is invalid');
        }
        const requestKind = progressRequestKind(input.requestKind);
        if (!Number.isSafeInteger(input.resume.attempts) || input.resume.attempts < 0 ||
            input.resume.attempts > MAX_PROGRESS_DELIVERY_ATTEMPTS ||
            !Array.isArray(input.resume.seenStages) ||
            input.resume.seenStages.length > MAX_PROGRESS_MESSAGES ||
            input.resume.attempts < input.resume.seenStages.length ||
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
        const metadata = Object.freeze({
            runId: input.runId,
            runRef: input.runRef,
            requestKind,
            observationPolicy,
            resume
        });
        try {
            this.#onAttachment?.(metadata);
        }
        catch {
            // Registration is fail-closed in the observation gate and cannot block the run.
        }
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
        if (state.terminal || state.seenStages.size >= MAX_PROGRESS_MESSAGES ||
            state.attempts >= MAX_PROGRESS_DELIVERY_ATTEMPTS)
            return;
        const progress = progressFor(event);
        if (progress === null || state.seenStages.has(progress.key))
            return;
        const step = state.seenStages.size + 1;
        const text = normalizedProgress(`${progress.text}（步骤 ${step}）`);
        if (text.length === 0)
            return;
        state.seenStages.add(progress.key);
        state.attempts += 1;
        state.queue = state.queue.then(async () => {
            await dismissIndicatorBestEffort(state.indicator, 'progress');
            let resultCode = 'no_result';
            const startedAt = this.#readMonotonic();
            const deliveries = [];
            try {
                let final = await state.outbound.deliver(plainTextPart(text), 1);
                deliveries.push(this.#safeDelivery(final));
                if (final.kind === 'failed_definite' && final.code === 'host_rejected' &&
                    state.attempts < MAX_PROGRESS_DELIVERY_ATTEMPTS) {
                    state.attempts += 1;
                    final = await state.outbound.deliver(plainTextPart(text), 2);
                    deliveries.push(this.#safeDelivery(final));
                }
                this.#publishProgress(state, text, deliveries, startedAt);
                if (final?.kind === 'sent')
                    return;
                resultCode = final?.kind ?? resultCode;
            }
            catch {
                resultCode = 'exception';
                deliveries.push(Object.freeze({
                    schemaVersion: 1,
                    media: 'text',
                    attempt: deliveries.length === 0 ? 1 : 2,
                    outcome: 'outcome_unknown',
                    code: 'unknown_host_result'
                }));
                this.#publishProgress(state, text, deliveries, startedAt);
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
    #safeDelivery(value) {
        if (value.kind === 'sent') {
            return Object.freeze({
                schemaVersion: 1,
                media: 'text',
                attempt: value.attempt,
                outcome: 'sent',
                code: null
            });
        }
        return value.kind === 'failed_definite'
            ? Object.freeze({
                schemaVersion: 1,
                media: 'text',
                attempt: value.attempt,
                outcome: 'failed_definite',
                code: value.code
            })
            : Object.freeze({
                schemaVersion: 1,
                media: 'text',
                attempt: value.attempt,
                outcome: 'outcome_unknown',
                code: value.code
            });
    }
    #publishProgress(state, text, deliveries, startedAt) {
        if (this.#publishObservation === undefined)
            return;
        const sent = deliveries.some(delivery => delivery.outcome === 'sent');
        const failed = deliveries.some(delivery => delivery.outcome === 'failed_definite');
        const unknown = deliveries.some(delivery => delivery.outcome === 'outcome_unknown');
        const outcome = sent
            ? failed || unknown ? 'partial' : 'complete'
            : unknown ? 'unknown' : 'failed';
        const finishedAt = this.#readMonotonic();
        const totalDurationMs = startedAt === 'unavailable' || finishedAt === 'unavailable' ||
            finishedAt < startedAt
            ? 'unavailable'
            : finishedAt - startedAt;
        try {
            this.#publishObservation(parseObservationEvent({
                schemaVersion: 1,
                type: 'presentation',
                value: {
                    schemaVersion: 1,
                    presentationObservationId: createPresentationObservationId(),
                    runRef: state.runRef,
                    terminalObservationId: 'not_attempted',
                    profile: 'progress',
                    outcome,
                    postprocessAnomaly: false,
                    deliveries,
                    totalDurationMs,
                    reducerInput: {
                        ...createProgressPresentationReducerInput({
                            requestKind: state.requestKind,
                            text
                        }),
                        fallbackReason: 'none'
                    }
                }
            }));
        }
        catch {
            // Observation projection and publication cannot affect progress delivery.
        }
    }
    #readMonotonic() {
        try {
            const value = this.#monotonicNow();
            return value === 'unavailable' ||
                (Number.isSafeInteger(value) && value >= 0)
                ? value
                : 'unavailable';
        }
        catch {
            return 'unavailable';
        }
    }
}
