import { EMPTY_PRESENTATION_TRACE, PRESENTATION_TRACE_MAX_BYTES, PRESENTATION_TRACE_MAX_REASONING_CODE_POINTS, parsePresentationTrace } from '../../agent/contracts/presentation-trace.js';
import { normalizeReasoningView } from './reply-content.js';
const OUTCOME_LABELS = Object.freeze({
    succeeded: '成功',
    denied: '已拒绝',
    failed: '失败',
    indeterminate: '结果待确认'
});
const FALLBACK_TRUNCATION_MARKER = '…（内容已截断）';
function selectedTraceValue(trace, segments, truncated) {
    return {
        schemaVersion: trace.schemaVersion,
        truncated,
        segments,
        ...(trace.schemaVersion === 2 && trace.usage !== undefined
            ? { usage: trace.usage }
            : {})
    };
}
function selectedTraceBytes(trace, segments, truncated) {
    return Buffer.byteLength(JSON.stringify(selectedTraceValue(trace, segments, truncated)), 'utf8');
}
function fitFallbackReasoning(trace, segments, fallback, step) {
    const complete = Object.freeze({
        kind: 'reasoning',
        step,
        turn: 1,
        text: fallback.text,
        truncated: fallback.truncated
    });
    const baseTruncated = trace.truncated || segments.some(segment => segment.truncated);
    if (selectedTraceBytes(trace, [...segments, complete], baseTruncated || complete.truncated) <= PRESENTATION_TRACE_MAX_BYTES) {
        return complete;
    }
    const markerPoints = [...FALLBACK_TRUNCATION_MARKER];
    const sourcePoints = [...fallback.text];
    let low = 0;
    let high = Math.min(sourcePoints.length, PRESENTATION_TRACE_MAX_REASONING_CODE_POINTS - markerPoints.length);
    let fitted = null;
    while (low <= high) {
        const retained = Math.floor((low + high) / 2);
        const candidate = Object.freeze({
            kind: 'reasoning',
            step,
            turn: 1,
            text: `${sourcePoints.slice(0, retained).join('')}${FALLBACK_TRUNCATION_MARKER}`,
            truncated: true
        });
        if (selectedTraceBytes(trace, [...segments, candidate], true) <= PRESENTATION_TRACE_MAX_BYTES) {
            fitted = candidate;
            low = retained + 1;
        }
        else {
            high = retained - 1;
        }
    }
    return fitted;
}
export function selectExecutionTrace(trace, settings, fallbackReasoning) {
    const parsed = parsePresentationTrace(trace);
    const hasProviderReasoning = parsed.segments.some(segment => segment.kind === 'reasoning');
    const segments = parsed.segments.filter(segment => (segment.kind === 'reasoning'
        ? settings.forwardReasoning
        : settings.forwardToolDetails));
    const fallback = hasProviderReasoning || !settings.forwardReasoning
        ? undefined
        : normalizeReasoningView(fallbackReasoning);
    let fallbackOmittedForBytes = false;
    if (fallback !== undefined) {
        const maximumStep = parsed.segments.reduce((maximum, segment) => Math.max(maximum, segment.step), -1);
        if (maximumStep < Number.MAX_SAFE_INTEGER) {
            const fitted = fitFallbackReasoning(parsed, segments, fallback, maximumStep + 1);
            if (fitted === null)
                fallbackOmittedForBytes = true;
            else
                segments.push(fitted);
        }
    }
    if (segments.length === 0 && parsed.schemaVersion === 1)
        return EMPTY_PRESENTATION_TRACE;
    return parsePresentationTrace(selectedTraceValue(parsed, segments, parsed.truncated || fallbackOmittedForBytes ||
        segments.some(segment => segment.truncated)));
}
function picoYuanAsYuan(picoYuan) {
    const PICO_YUAN_DIGITS = 12;
    if (picoYuan.length <= PICO_YUAN_DIGITS) {
        const fraction = picoYuan.padStart(PICO_YUAN_DIGITS, '0').replace(/0+$/u, '');
        return fraction === '' ? '0' : `0.${fraction}`;
    }
    const whole = picoYuan.slice(0, -PICO_YUAN_DIGITS);
    const fraction = picoYuan.slice(-PICO_YUAN_DIGITS).replace(/0+$/u, '');
    return fraction === '' ? whole : `${whole}.${fraction}`;
}
function usageNodeText(usage) {
    const partial = usage.availability === 'complete'
        ? ''
        : '（已记录/可确认部分）';
    const inputLine = usage.cacheUsageComplete
        ? `输入 ${usage.inputTokens}（缓存命中 ${usage.cacheHitTokens}，未命中 ${usage.cacheMissTokens}）${partial}`
        : `输入 ${usage.inputTokens}${partial}（已记录缓存命中 ${usage.cacheHitTokens}，未命中 ${usage.cacheMissTokens}；缓存明细不完整）`;
    const costLines = usage.cost.kind === 'exact'
        ? [`参考费用 ¥${picoYuanAsYuan(usage.cost.picoYuan)}`]
        : usage.cost.kind === 'upper_bound'
            ? [
                `参考费用上限 ¥${picoYuanAsYuan(usage.cost.picoYuan)}`,
                '缓存明细不完整，全部输入按未命中估算'
            ]
            : ['参考费用不可用'];
    const catalogVersion = usage.cost.catalogVersion ?? '不可用';
    return [
        '【Token 与费用】',
        inputLine,
        `输出 ${usage.outputTokens}；合计 ${usage.totalTokens}${partial}`,
        ...costLines,
        `价格表 ${catalogVersion}；非供应商账单`
    ].join('\n');
}
export function executionTraceForwardPart(trace) {
    const parsed = parsePresentationTrace(trace);
    const hasReasoning = parsed.segments.some(segment => segment.kind === 'reasoning');
    const hasTools = parsed.segments.some(segment => segment.kind === 'tool');
    let reasoningIndex = 0;
    const nodes = parsed.segments.map(segment => {
        if (segment.kind === 'reasoning') {
            reasoningIndex += 1;
            return Object.freeze({
                kind: 'text',
                text: `【模型思考 ${reasoningIndex}】\n${segment.text}`
            });
        }
        return Object.freeze({
            kind: 'text',
            text: [
                `【工具执行：${segment.toolName}】`,
                `状态：${OUTCOME_LABELS[segment.outcome]}`,
                `参数：${segment.argumentsSummary}`,
                `结果：${segment.resultSummary}`
            ].join('\n')
        });
    });
    if (parsed.schemaVersion === 2 && parsed.usage !== undefined) {
        nodes.push(Object.freeze({
            kind: 'text',
            text: usageNodeText(parsed.usage)
        }));
    }
    return Object.freeze({
        media: 'forward',
        title: hasReasoning && hasTools
            ? '执行过程'
            : hasReasoning
                ? '思考过程'
                : '工具执行详情',
        nodes: Object.freeze(nodes)
    });
}
