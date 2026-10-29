import { RUN_REF_PATTERN } from '../../agent/run/run-reference.js';
import { replayTrace } from './trace-replay.js';
const STATUS_MAXIMUM_CODE_POINTS = 2_000;
const INSPECT_MAXIMUM_CODE_POINTS = 4_000;
const REPORT_MAXIMUM_CODE_POINTS = 4_000;
const RECENT_TRACE_LIMIT = 5;
const INSPECT_EVENT_LIMIT = 20;
const COUNTER_ROW_LIMIT = 40;
const PICO_YUAN_PER_YUAN = 1000000000000n;
const PICO_YUAN_PER_MICRO_YUAN = 1000000n;
function boundedText(value, maximum) {
    const codePoints = [...value];
    if (codePoints.length <= maximum)
        return value;
    return `${codePoints.slice(0, maximum - 1).join('')}…`;
}
function response(kind, text, maximum) {
    return Object.freeze({
        schemaVersion: 1,
        kind,
        text: boundedText(text, maximum)
    });
}
function levelLabel(level) {
    if (level === 'off')
        return '关闭';
    if (level === 'diagnostic')
        return '诊断';
    return '基础';
}
function gauge(snapshot, name, labelName, labelValue) {
    const point = snapshot.gauges.find(point => (point.name === name &&
        (labelName === undefined || point.labels.some(label => (label.name === labelName && label.value === labelValue)))));
    return point === undefined ? '不可用' : String(point.value);
}
function recentLines(recent) {
    if (recent.length === 0)
        return Object.freeze(['最近轨迹：无']);
    return Object.freeze([
        '最近轨迹：',
        ...recent.slice(0, RECENT_TRACE_LIMIT).map(item => (`${item.runRef} ${item.outcome}/${item.retention}`))
    ]);
}
function sumRows(rows) {
    return rows.reduce((total, row) => total + row.count, 0);
}
/** Pico-yuan to yuan with micro-yuan precision; the input is always non-negative. */
function formatPicoYuan(picoYuan) {
    let value;
    try {
        value = BigInt(picoYuan);
    }
    catch {
        return '不可用';
    }
    const micro = (value % PICO_YUAN_PER_YUAN) / PICO_YUAN_PER_MICRO_YUAN;
    return `${value / PICO_YUAN_PER_YUAN}.${String(micro).padStart(6, '0')}`;
}
function costText(cost) {
    if (cost.kind === 'unavailable')
        return '不可用';
    const label = cost.kind === 'upper_bound' ? '上界' : '参考';
    return `${label} ${formatPicoYuan(cost.picoYuan)} 元（${cost.catalogVersion}）`;
}
function availabilityLabel(availability) {
    if (availability === 'complete')
        return '完整';
    return availability === 'partial' ? '部分' : '不可用';
}
function labelText(labels) {
    return labels.map(label => `${label.name}=${label.value}`).join(',');
}
function pointsOf(snapshot, name) {
    return snapshot.counters.filter(point => point.name === name);
}
function sumByLabel(points, labelName) {
    const totals = new Map();
    for (const point of points) {
        const value = point.labels.find(label => label.name === labelName)?.value;
        if (value === undefined)
            continue;
        totals.set(value, (totals.get(value) ?? 0) + point.value);
    }
    return [...totals.entries()].sort((left, right) => (right[1] - left[1] || left[0].localeCompare(right[0])));
}
function breakdown(points, labelName) {
    const rows = sumByLabel(points, labelName);
    if (rows.length === 0)
        return '无';
    return rows.map(([value, count]) => `${value} ${count}`).join(' / ');
}
function tokenTotal(snapshot, direction) {
    return pointsOf(snapshot, 'groupmate.agent.tokens')
        .filter(point => point.labels.some(label => (label.name === 'direction' && label.value === direction)) && point.labels.some(label => (label.name === 'source' && label.value === 'provider')))
        .reduce((total, point) => total + point.value, 0);
}
/** Bucket upper bound that first covers the quantile; never an interpolated value. */
function quantileBound(point, quantile) {
    if (point.count === 0)
        return '无';
    const target = Math.max(1, Math.ceil(point.count * quantile));
    for (const bucket of point.buckets) {
        if (bucket.cumulativeCount >= target) {
            return bucket.upperBoundMs === 'inf' ? '超出最大桶' : `≤${bucket.upperBoundMs}ms`;
        }
    }
    return '超出最大桶';
}
function histogramLine(point) {
    const mean = point.count === 0 ? '无' : `${Math.round(point.sumMs / point.count)}ms`;
    return `${point.name}{${labelText(point.labels)}} ${point.count} 次 均值 ${mean} ` +
        `p50 ${quantileBound(point, 0.5)} p95 ${quantileBound(point, 0.95)} ` +
        `不可用 ${point.unavailableCount}`;
}
function totalsText(totals) {
    return `运行 ${totals.runs} 输入 ${totals.inputTokens} 输出 ${totals.outputTokens} ` +
        `缓存命中 ${totals.cacheHitTokens} 费用 ${costText(totals.cost)}`;
}
function windowLine(startedAt, resetCount) {
    return `计数窗口：${startedAt} 起（重置 ${resetCount} 次）`;
}
function replayText(report) {
    const phases = report.phases.slice(0, INSPECT_EVENT_LIMIT);
    const phaseLines = phases.map((phase, index) => `${index + 1}. ${phase}`);
    const remaining = Math.max(0, report.phases.length - phases.length);
    if (remaining > 0)
        phaseLines.push(`其余 ${remaining} 个阶段未展开`);
    const presentation = report.presentation.kind === 'unavailable'
        ? '不可用'
        : `${report.presentation.selectedMode}/${report.presentation.fallbackReason}`;
    return [
        'GroupMate 轨迹诊断',
        `runRef：${report.runRef}`,
        `结果：${report.outcome}`,
        `省略事件：${report.omittedEventCount}`,
        `不支持事件：${report.unsupportedEventCount}`,
        `模型请求：${sumRows(report.metricSummary.providerRequests)}`,
        `工具执行：${sumRows(report.metricSummary.toolExecutions)}`,
        `审批事件：${sumRows(report.metricSummary.approvals)}`,
        `呈现：${presentation}`,
        '阶段：',
        ...phaseLines
    ].join('\n');
}
export class OwnerDiagnostics {
    #metrics;
    #traceStore;
    #currentLevel;
    #usage;
    #pipeline;
    #logger;
    constructor(options) {
        this.#metrics = options.metrics;
        this.#traceStore = options.traceStore;
        this.#currentLevel = options.currentLevel;
        this.#usage = options.usage;
        this.#pipeline = options.pipeline;
        this.#logger = options.logger;
    }
    async status(input) {
        if (!input.authorized)
            return this.#finish('status', response('forbidden', '仅机器人主人可以查看 GroupMate 状态', STATUS_MAXIMUM_CODE_POINTS));
        let level;
        let snapshot;
        try {
            level = this.#currentLevel();
            snapshot = await this.#metrics.snapshot();
        }
        catch {
            return this.#finish('status', response('unavailable', 'GroupMate 状态暂不可用', STATUS_MAXIMUM_CODE_POINTS));
        }
        let recent = Object.freeze([]);
        if (level !== 'off') {
            try {
                recent = (await this.#traceStore.listRecent(RECENT_TRACE_LIMIT)).slice(0, RECENT_TRACE_LIMIT);
            }
            catch { }
        }
        const traceLines = level === 'off'
            ? ['轨迹：关闭']
            : [
                `轨迹：${gauge(snapshot, 'groupmate.observation.store_records', 'kind', 'trace')} 条 / ${gauge(snapshot, 'groupmate.observation.store_bytes', 'kind', 'trace')} 字节`,
                ...recentLines(recent)
            ];
        return this.#finish('status', response('status', [
            'GroupMate 状态',
            `可观测性：${levelLabel(level)}`,
            `活动任务：${gauge(snapshot, 'groupmate.agent.admission', 'state', 'active')}`,
            `排队任务：${gauge(snapshot, 'groupmate.agent.admission', 'state', 'queued')}`,
            `RSS：${gauge(snapshot, 'groupmate.process.rss')} 字节`,
            ...(level === 'off'
                ? []
                : [
                    windowLine(snapshot.startedAt, snapshot.windowResetCount),
                    `运行：${breakdown(pointsOf(snapshot, 'groupmate.agent.runs'), 'outcome')}`,
                    `上报 Token：输入 ${tokenTotal(snapshot, 'input')} / ` +
                        `输出 ${tokenTotal(snapshot, 'output')}`,
                    `报价：${breakdown(pointsOf(snapshot, 'groupmate.agent.model_price'), 'status')}`,
                    ...this.#costLines()
                ]),
            ...traceLines
        ].join('\n'), STATUS_MAXIMUM_CODE_POINTS));
    }
    /** Full counter and histogram read-out; `#GroupMate状态` only carries a digest. */
    async metricsReport(input) {
        if (!input.authorized)
            return this.#finish('metrics', response('forbidden', '仅机器人主人可以查看 GroupMate 指标', REPORT_MAXIMUM_CODE_POINTS));
        let level;
        let snapshot;
        try {
            level = this.#currentLevel();
            snapshot = await this.#metrics.snapshot();
        }
        catch {
            return this.#finish('metrics', response('unavailable', 'GroupMate 指标暂不可用', REPORT_MAXIMUM_CODE_POINTS));
        }
        if (level === 'off')
            return this.#finish('metrics', response('metrics', ['GroupMate 指标', '可观测性：关闭', '计数：关闭'].join('\n'), REPORT_MAXIMUM_CODE_POINTS));
        const counters = [...snapshot.counters]
            .sort((left, right) => (right.value - left.value ||
            left.name.localeCompare(right.name) ||
            labelText(left.labels).localeCompare(labelText(right.labels))));
        const shown = counters.slice(0, COUNTER_ROW_LIMIT);
        const remaining = counters.length - shown.length;
        return this.#finish('metrics', response('metrics', [
            'GroupMate 指标',
            `可观测性：${levelLabel(level)}`,
            windowLine(snapshot.startedAt, snapshot.windowResetCount),
            '计数：',
            ...(shown.length === 0
                ? ['无']
                : shown.map(point => `${point.name}{${labelText(point.labels)}} ${point.value}`)),
            ...(remaining > 0 ? [`其余 ${remaining} 个计数未展开`] : []),
            '耗时：',
            ...(snapshot.histograms.length === 0
                ? ['无']
                : [...snapshot.histograms]
                    .sort((left, right) => (left.name.localeCompare(right.name) ||
                    labelText(left.labels).localeCompare(labelText(right.labels))))
                    .map(histogramLine)),
            ...this.#pipelineLines()
        ].join('\n'), REPORT_MAXIMUM_CODE_POINTS));
    }
    /**
     * Per-identity token and cost totals. Rows carry masked trailing digits only:
     * two rows with the same mask are two different groups or people.
     */
    async usageReport(input) {
        if (!input.authorized)
            return this.#finish('usage', response('forbidden', '仅机器人主人可以查看 GroupMate 用量', REPORT_MAXIMUM_CODE_POINTS));
        if (this.#usage === undefined)
            return this.#finish('usage', response('unavailable', '用量聚合未启用，可在锅巴打开「按群与按人用量聚合」', REPORT_MAXIMUM_CODE_POINTS));
        let level;
        let usage;
        try {
            level = this.#currentLevel();
            usage = this.#usage();
        }
        catch {
            return this.#finish('usage', response('unavailable', 'GroupMate 用量暂不可用', REPORT_MAXIMUM_CODE_POINTS));
        }
        if (level === 'off')
            return this.#finish('usage', response('usage', ['GroupMate 用量', '可观测性：关闭', '聚合：关闭'].join('\n'), REPORT_MAXIMUM_CODE_POINTS));
        return this.#finish('usage', response('usage', [
            'GroupMate 用量',
            `可观测性：${levelLabel(level)}`,
            windowLine(usage.windowStartedAt, usage.windowResetCount),
            `累计：${totalsText(usage.total)}`,
            `用量完整度：${availabilityLabel(usage.total.availability)}`,
            `已统计运行：${usage.observedRuns}（拒绝 ${usage.rejectedRuns}）`,
            '按天：',
            ...(usage.days.length === 0
                ? ['无']
                : usage.days.map(row => `${row.day} ${totalsText(row.totals)}`)),
            '按群（掩码尾号）：',
            ...(usage.groups.length === 0
                ? ['无']
                : usage.groups.map(row => `${row.maskedId} ${row.day} ${totalsText(row.totals)}`)),
            '按人（掩码尾号）：',
            ...(usage.actors.length === 0
                ? ['无']
                : usage.actors.map(row => `${row.maskedId} ${row.day} ${totalsText(row.totals)}`)),
            `维度溢出：群 ${usage.droppedGroupRuns} / 人 ${usage.droppedActorRuns}`
        ].join('\n'), REPORT_MAXIMUM_CODE_POINTS));
    }
    async inspect(input) {
        if (!input.authorized)
            return this.#finish('inspect', response('forbidden', '仅机器人主人可以查看 GroupMate 诊断', INSPECT_MAXIMUM_CODE_POINTS));
        if (!RUN_REF_PATTERN.test(input.runRef))
            return this.#finish('inspect', response('invalid_run_ref', 'runRef 格式无效，应为 32 位小写十六进制字符', INSPECT_MAXIMUM_CODE_POINTS));
        let lookup;
        try {
            lookup = await this.#traceStore.load(input.runRef);
        }
        catch {
            lookup = Object.freeze({ kind: 'unavailable' });
        }
        if (lookup.kind !== 'found') {
            const messages = {
                not_retained: '该运行轨迹未保留',
                expired: '该运行轨迹已过期',
                unavailable: '轨迹存储暂不可用',
                corrupt: '该运行轨迹已损坏'
            };
            return this.#finish('inspect', response(lookup.kind, messages[lookup.kind], INSPECT_MAXIMUM_CODE_POINTS));
        }
        const replay = replayTrace(lookup.record);
        if (replay.kind !== 'replayed')
            return this.#finish('inspect', response('corrupt', '该运行轨迹已损坏', INSPECT_MAXIMUM_CODE_POINTS));
        return this.#finish('inspect', response('found', replayText(replay.report), INSPECT_MAXIMUM_CODE_POINTS));
    }
    #costLines() {
        if (this.#usage === undefined)
            return Object.freeze([]);
        try {
            const usage = this.#usage();
            return Object.freeze([
                `累计费用：${costText(usage.total.cost)}`,
                `已统计运行：${usage.observedRuns}`
            ]);
        }
        catch {
            return Object.freeze(['累计费用：不可用']);
        }
    }
    #pipelineLines() {
        if (this.#pipeline === undefined)
            return Object.freeze([]);
        let pipeline;
        try {
            pipeline = this.#pipeline();
        }
        catch {
            return Object.freeze(['管道：不可用']);
        }
        return Object.freeze([
            '管道：',
            `进行中 ${pipeline.hub.normalInFlight} 等待 ${pipeline.hub.normalPending} ` +
                `保留槽 ${pipeline.hub.reservedInFlight}`,
            ...pipeline.hub.sinks.map(sink => (`${sink.name} 接受 ${sink.accepted} 丢弃 ${sink.dropped} ` +
                `失败 ${sink.failed} 隔离 ${sink.quarantined}`)),
            `轨迹记录：候选等待 ${pipeline.recorder.committedCandidateWait} ` +
                `呈现等待 ${pipeline.recorder.presentationWait}`
        ]);
    }
    #finish(operation, value) {
        try {
            this.#logger?.info?.(Object.freeze({
                event: 'groupmate.owner_diagnostics',
                operation,
                outcome: value.kind
            }));
        }
        catch { }
        return value;
    }
}
