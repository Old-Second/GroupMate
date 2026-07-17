import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
const MAX_AUDIT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_AUDIT_FILES = 512;
const FORBIDDEN_FACT_FIELDS = Object.freeze([
    'prompt',
    'messages',
    'message',
    'content',
    'text',
    'reasoning',
    'arguments',
    'toolArguments',
    'toolResult',
    'result',
    'callId',
    'toolName',
    'userId',
    'groupId',
    'sessionId',
    'runId',
    'model',
    'endpoint',
    'apiKey',
    'token',
    'cookie'
]);
const FACT_FILES = Object.freeze([
    'src/runtime/observability/observation-event.ts',
    'src/runtime/observability/safe-observation-logging.ts',
    'src/runtime/observability/trace-record.ts',
    'src/runtime/observability/metrics-registry.ts',
    'src/agent/run/run-observation.ts',
    'src/agent/run/run-trace.ts'
]);
const LOGGER_FILES = Object.freeze([
    ...FACT_FILES,
    'src/runtime/observability/owner-diagnostics.ts',
    'src/runtime/production-yunzai-agent.ts',
    'src/runtime/safe-chat-logging.ts',
    'src/runtime/run-progress-presenter.ts',
    'src/runtime/tools/yunzai-tool-runtime.ts',
    'src/runtime/agent-service-bridge.ts'
]);
const TRACE_DIAGNOSTIC_FILES = Object.freeze([
    'src/runtime/observability/redis-trace-store.ts',
    'src/runtime/observability/owner-diagnostics.ts',
    'src/runtime/observability/trace-replay.ts',
    'src/runtime/yunzai-diagnostics-controller.ts',
    'apps/diagnostics.js'
]);
const EXPECTED_METRICS = Object.freeze({
    counter: Object.freeze([
        'groupmate.agent.runs',
        'groupmate.agent.provider_requests',
        'groupmate.agent.tokens',
        'groupmate.agent.tool_executions',
        'groupmate.agent.approvals',
        'groupmate.agent.admission_rejections',
        'groupmate.presentation.deliveries',
        'groupmate.observation.failures'
    ]),
    gauge: Object.freeze([
        'groupmate.agent.admission',
        'groupmate.observation.store_records',
        'groupmate.observation.store_bytes',
        'groupmate.process.rss'
    ]),
    histogram: Object.freeze([
        'groupmate.agent.duration',
        'groupmate.agent.tool_duration'
    ])
});
const EXPECTED_METRIC_LABELS = Object.freeze({
    'groupmate.agent.runs': Object.freeze(['outcome', 'completion_kind', 'error_code']),
    'groupmate.agent.duration': Object.freeze(['stage']),
    'groupmate.agent.provider_requests': Object.freeze(['outcome', 'attempt_kind']),
    'groupmate.agent.tokens': Object.freeze(['direction', 'source']),
    'groupmate.agent.tool_executions': Object.freeze(['outcome']),
    'groupmate.agent.tool_duration': Object.freeze(['outcome']),
    'groupmate.agent.approvals': Object.freeze(['decision']),
    'groupmate.agent.admission': Object.freeze(['state']),
    'groupmate.agent.admission_rejections': Object.freeze(['reason']),
    'groupmate.presentation.deliveries': Object.freeze(['media', 'outcome']),
    'groupmate.observation.failures': Object.freeze(['sink']),
    'groupmate.observation.store_records': Object.freeze(['kind']),
    'groupmate.observation.store_bytes': Object.freeze(['kind']),
    'groupmate.process.rss': Object.freeze([])
});
const THIN_SCRIPTS = Object.freeze({
    'scripts/phase-6-resource-scenario.mjs': 'phase-6-resource-scenario.js',
    'scripts/measure-phase-6-resources.mjs': 'phase-6-resource-report.js',
    'scripts/smoke-phase-6-redis.mjs': 'phase-6-redis-smoke.js',
    'scripts/verify-phase-6.mjs': 'phase-6-verification.js'
});
function normalizeRelativePath(value) {
    const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
    if (normalized === '' || normalized.startsWith('/') || normalized.includes('../') ||
        normalized.includes('\0'))
        throw new TypeError('security audit path is invalid');
    return normalized;
}
function validateRoot(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError('security audit project root is invalid');
    }
    return path.resolve(value);
}
function validateOverrides(value) {
    if (value === undefined)
        return Object.freeze({});
    const output = {};
    for (const [rawPath, source] of Object.entries(value)) {
        const relativePath = normalizeRelativePath(rawPath);
        if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > MAX_AUDIT_FILE_BYTES) {
            throw new TypeError('security audit source override is invalid');
        }
        output[relativePath] = source;
    }
    return Object.freeze(output);
}
function finding(target, relativePath, code) {
    target.add(`${relativePath}:${code}`);
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function sameSet(left, right) {
    return left.length === right.length &&
        new Set(left).size === left.length &&
        new Set(right).size === right.length &&
        left.every(value => right.includes(value)) &&
        right.every(value => left.includes(value));
}
async function collectFiles(root, relative = '', suffix = '') {
    const current = path.join(root, relative);
    let entries;
    try {
        entries = await readdir(current, { withFileTypes: true });
    }
    catch {
        return Object.freeze([]);
    }
    const output = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory())
            output.push(...await collectFiles(root, child, suffix));
        else if (entry.isFile() && (suffix === '' || child.endsWith(suffix)))
            output.push(child);
        if (output.length > MAX_AUDIT_FILES)
            throw new RangeError('security audit file count exceeded');
    }
    return Object.freeze(output);
}
function stringUnion(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    if (start < 0 || end < 0)
        return Object.freeze([]);
    return Object.freeze([...source.slice(start, end).matchAll(/'([^']+)'/g)]
        .map(match => match[1])
        .filter(value => value.startsWith('groupmate.')));
}
function exactThinScript(source, target) {
    const escaped = escapeRegex(target);
    return new RegExp(`^import \\{ main \\} from '../dist/verification/${escaped}';?\\nawait main\\(\\);?\\n?$`).test(source);
}
function methodSection(source, start, end) {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex + start.length);
    return startIndex < 0 || endIndex < 0 ? '' : source.slice(startIndex, endIndex);
}
function persistedFactSurface(relativePath, source) {
    const cutoff = relativePath === 'src/runtime/observability/observation-event.ts'
        ? 'export const MAX_PRESENTATION_DELIVERY_OBSERVATIONS'
        : relativePath === 'src/agent/run/run-observation.ts'
            ? 'const COUNTER_KEYS'
            : null;
    if (cutoff === null)
        return source;
    const index = source.indexOf(cutoff);
    return index < 0 ? source : source.slice(0, index);
}
async function auditSourceDist(root, readSource, findings) {
    const temporary = await mkdtemp(path.join(tmpdir(), 'groupmate-phase6-audit-'));
    try {
        const compiler = path.join(root, 'node_modules/typescript/bin/tsc');
        const result = spawnSync(process.execPath, [
            compiler,
            '-p',
            path.join(root, 'tsconfig.json'),
            '--outDir',
            temporary,
            '--sourceMap',
            'false',
            '--declaration',
            'false',
            '--incremental',
            'false'
        ], {
            cwd: root,
            encoding: 'utf8',
            timeout: 60_000,
            maxBuffer: 1024 * 1024,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        if (result.status !== 0 || result.error !== undefined) {
            findings.add('dist:compile_failed');
            return;
        }
        const generated = await collectFiles(temporary, '', '.js');
        const actual = await collectFiles(path.join(root, 'dist'), '', '.js');
        const generatedSet = new Set(generated);
        const actualSet = new Set(actual);
        for (const relativePath of generated) {
            const distPath = `dist/${relativePath}`;
            if (!actualSet.has(relativePath)) {
                finding(findings, distPath, 'missing');
                continue;
            }
            const expected = await readFile(path.join(temporary, relativePath), 'utf8');
            const current = await readSource(distPath);
            if (current === null || current !== expected)
                finding(findings, distPath, 'content');
        }
        for (const relativePath of actual) {
            if (!generatedSet.has(relativePath))
                finding(findings, `dist/${relativePath}`, 'stale');
        }
    }
    finally {
        await rm(temporary, { recursive: true, force: true });
    }
}
function gitChanged(root, arguments_) {
    const result = spawnSync('git', arguments_, {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 256 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    if (result.error !== undefined || result.status === null || result.status > 1)
        return 'unavailable';
    return result.status === 1 || result.stdout.trim() !== '';
}
export async function auditPhase6SecurityBoundaries(projectRoot, options = {}) {
    const root = validateRoot(projectRoot);
    const overrides = validateOverrides(options.sourceOverrides);
    const forbiddenFields = new Set();
    const unsafeLoggerCalls = new Set();
    const forbiddenTraceRedisCommands = new Set();
    const dynamicMetricDefinitions = new Set();
    const sourceDistMismatches = new Set();
    const forbiddenProductionEdges = new Set();
    const readSource = async (rawPath) => {
        const relativePath = normalizeRelativePath(rawPath);
        if (Object.hasOwn(overrides, relativePath))
            return overrides[relativePath];
        try {
            const value = await readFile(path.join(root, relativePath), 'utf8');
            if (Buffer.byteLength(value, 'utf8') > MAX_AUDIT_FILE_BYTES) {
                finding(forbiddenProductionEdges, relativePath, 'oversized');
                return null;
            }
            return value;
        }
        catch {
            return null;
        }
    };
    for (const relativePath of FACT_FILES) {
        const source = await readSource(relativePath);
        if (source === null) {
            finding(forbiddenProductionEdges, relativePath, 'missing');
            continue;
        }
        const surface = persistedFactSurface(relativePath, source);
        for (const field of FORBIDDEN_FACT_FIELDS) {
            const pattern = new RegExp(`(?:readonly\\s+)?(?:['"])?${escapeRegex(field)}(?:['"])?\\s*[?:]`);
            if (pattern.test(surface))
                finding(forbiddenFields, relativePath, field);
        }
    }
    for (const relativePath of new Set(LOGGER_FILES)) {
        const source = await readSource(relativePath);
        if (source === null)
            continue;
        const compact = source.replace(/\s+/g, ' ');
        const direct = /(?:logger|console)(?:\?\.)?\.(?:error|warn|info|log)(?:\?\.)?\s*\(\s*(?:String\s*\(\s*)?(?:error|err|cause)\b/i;
        const member = /(?:logger|console)(?:\?\.)?\.(?:error|warn|info|log)(?:\?\.)?\s*\([^)]*(?:error|err|cause)\.(?:message|stack)/i;
        const spread = /(?:logger|console)(?:\?\.)?\.(?:error|warn|info|log)(?:\?\.)?\s*\([^)]*\.\.\.(?:error|err|cause)\b/i;
        const object = /(?:logger|console)(?:\?\.)?\.(?:error|warn|info|log)(?:\?\.)?\s*\([^)]*\{[^}]*\b(?:error|err|cause)\b(?:\s*[:,}])/i;
        const trailing = /(?:logger|console)(?:\?\.)?\.(?:error|warn|info|log)(?:\?\.)?\s*\([^)]*,\s*(?:error|err|cause)\s*\)/i;
        if (direct.test(compact) || member.test(compact) || spread.test(compact) ||
            object.test(compact) || trailing.test(compact)) {
            finding(unsafeLoggerCalls, relativePath, 'direct_error');
        }
    }
    for (const relativePath of TRACE_DIAGNOSTIC_FILES) {
        const source = await readSource(relativePath);
        if (source === null) {
            finding(forbiddenProductionEdges, relativePath, 'missing');
            continue;
        }
        for (const command of ['KEYS', 'SCAN']) {
            const redisCall = new RegExp(`redis\\.call\\(\\s*['"]${command}['"]`, 'i');
            const clientCall = new RegExp(`\\.${command.toLowerCase()}\\s*\\(`);
            if (redisCall.test(source) || clientCall.test(source)) {
                finding(forbiddenTraceRedisCommands, relativePath, command);
            }
        }
    }
    const metricsPath = 'src/runtime/observability/metrics-registry.ts';
    const metrics = await readSource(metricsPath);
    if (metrics === null) {
        finding(dynamicMetricDefinitions, metricsPath, 'missing');
    }
    else {
        const counter = stringUnion(metrics, 'export type MetricCounterNameV1', 'export type MetricGaugeNameV1');
        const gauge = stringUnion(metrics, 'export type MetricGaugeNameV1', 'export type MetricHistogramNameV1');
        const histogram = stringUnion(metrics, 'export type MetricHistogramNameV1', 'export type AgentDurationStageV1');
        if (!sameSet(counter, EXPECTED_METRICS.counter) ||
            !sameSet(gauge, EXPECTED_METRICS.gauge) ||
            !sameSet(histogram, EXPECTED_METRICS.histogram)) {
            finding(dynamicMetricDefinitions, metricsPath, 'instrument_set');
        }
        const compact = metrics.replace(/\s+/g, '');
        for (const [name, labels] of Object.entries(EXPECTED_METRIC_LABELS)) {
            const expected = `'${name}':Object.freeze([${labels.map(label => `'${label}'`).join(',')}])`;
            if (!compact.includes(expected))
                finding(dynamicMetricDefinitions, metricsPath, `labels:${name}`);
        }
        const known = new Set(Object.keys(EXPECTED_METRIC_LABELS));
        for (const match of metrics.matchAll(/['"](groupmate\.[a-z0-9_.]+)['"]/gi)) {
            const name = match[1];
            if (!known.has(name))
                finding(dynamicMetricDefinitions, metricsPath, `unknown:${name}`);
        }
        if (/groupmate\.\$\{|['"]groupmate\.['"]\s*\+/.test(metrics)) {
            finding(dynamicMetricDefinitions, metricsPath, 'dynamic_name');
        }
    }
    const observationPath = 'src/runtime/observability/observation-event.ts';
    const hubPath = 'src/runtime/observability/observation-hub.ts';
    const progressPath = 'src/runtime/run-progress-presenter.ts';
    const toolsPath = 'src/runtime/tools/yunzai-tool-runtime.ts';
    const observation = await readSource(observationPath);
    const hub = await readSource(hubPath);
    const progress = await readSource(progressPath);
    const tools = await readSource(toolsPath);
    if (observation !== null) {
        const facts = methodSection(observation, 'export type ObservationEventV1 =', 'export const MAX_PRESENTATION_DELIVERY_OBSERVATIONS');
        const types = [...facts.matchAll(/type:\s*'([^']+)'/g)].map(match => match[1]);
        if (!sameSet(types, ['request', 'terminal_snapshot', 'terminal_commit', 'presentation'])) {
            finding(forbiddenProductionEdges, observationPath, 'fact_union');
        }
    }
    if ((observation ?? '').match(/\b(?:AgentEvent|ToolAuditEvent)\b/) !== null ||
        (hub ?? '').match(/\b(?:AgentEvent|ToolAuditEvent)\b/) !== null) {
        finding(forbiddenProductionEdges, hubPath, 'raw_event_edge');
    }
    const progressMarkers = [
        "type: 'presentation'",
        "profile: 'progress'",
        "terminalObservationId: 'not_attempted'",
        'parseObservationEvent({'
    ];
    if (progress === null || progressMarkers.some(marker => !progress.includes(marker))) {
        finding(forbiddenProductionEdges, progressPath, 'progress_projection');
    }
    if (tools !== null && /ObservationHub|ObservationEventV1|observability\.publish/.test(tools)) {
        finding(forbiddenProductionEdges, toolsPath, 'tool_audit_hub_edge');
    }
    const ownerPath = 'src/runtime/observability/owner-diagnostics.ts';
    const owner = await readSource(ownerPath);
    if (owner === null) {
        finding(forbiddenProductionEdges, ownerPath, 'missing');
    }
    else {
        const status = methodSection(owner, 'async status (', 'async inspect (');
        const inspect = methodSection(owner, 'async inspect (', '#finish (');
        const statusAuth = status.indexOf('if (!input.authorized)');
        const statusRead = status.indexOf('this.#metrics.snapshot()');
        if (statusAuth < 0 || statusRead < 0 || statusAuth > statusRead) {
            finding(forbiddenProductionEdges, ownerPath, 'status_auth_order');
        }
        const inspectAuth = inspect.indexOf('if (!input.authorized)');
        const inspectRead = inspect.indexOf('this.#traceStore.load(input.runRef)');
        if (inspectAuth < 0 || inspectRead < 0 || inspectAuth > inspectRead) {
            finding(forbiddenProductionEdges, ownerPath, 'inspect_auth_order');
        }
        const exactRef = inspect.indexOf('RUN_REF_PATTERN.test(input.runRef)');
        if (exactRef < 0 || inspectRead < 0 || exactRef > inspectRead ||
            /runRef\.(?:startsWith|slice)|runRefPrefix/.test(inspect)) {
            finding(forbiddenProductionEdges, ownerPath, 'exact_run_ref');
        }
    }
    const diagnosticsPath = 'apps/diagnostics.js';
    const diagnostics = await readSource(diagnosticsPath);
    if (diagnostics === null || diagnostics.match(/permission:\s*'master'/g)?.length !== 2 ||
        !diagnostics.includes('authorized: event?.isMaster === true') ||
        !diagnostics.includes('([0-9a-f]{32})')) {
        finding(forbiddenProductionEdges, diagnosticsPath, 'authorization_projection');
    }
    for (const relativePath of ['apps/chat.js', 'apps/bym.js']) {
        const source = await readSource(relativePath);
        if (source === null ||
            !source.includes("getProductionYunzaiAgent } from '../dist/runtime/production-yunzai-agent.js'") ||
            /(?:this\.)?reply\s*\(|\.sendMsg\s*\(|cacheContent|renderImage|new\s+ReplyPresenter|\bConfig\b/.test(source)) {
            finding(forbiddenProductionEdges, relativePath, 'legacy_presentation');
        }
    }
    for (const relativePath of [
        'src/runtime/production-yunzai-agent.ts',
        'src/runtime/agent-service-bridge.ts',
        'src/runtime/yunzai-chat-controller.ts',
        'src/runtime/yunzai-bym-controller.ts',
        'apps/chat.js',
        'apps/bym.js'
    ]) {
        const source = await readSource(relativePath);
        if (source !== null && /(?:from\s+|import\s*(?:\(\s*)?)['"][^'"]*(?:apps\/(?:chat|bym)|legacy[-_/].*presenter|utils\/render)|cacheContent|renderImage/.test(source)) {
            finding(forbiddenProductionEdges, relativePath, 'legacy_presenter_import');
        }
    }
    for (const [relativePath, target] of Object.entries(THIN_SCRIPTS)) {
        const source = await readSource(relativePath);
        if (source === null || !exactThinScript(source, target)) {
            finding(forbiddenProductionEdges, relativePath, 'not_thin');
        }
    }
    if (options.serverStaticChanged === true) {
        forbiddenProductionEdges.add('server/static:changed');
    }
    else if (options.skipGitDiffCheck !== true) {
        const checks = [
            gitChanged(root, ['diff', '--quiet', '--', 'server/static']),
            gitChanged(root, ['diff', '--cached', '--quiet', '--', 'server/static']),
            gitChanged(root, ['ls-files', '--others', '--exclude-standard', '--', 'server/static'])
        ];
        if (checks.includes('unavailable'))
            forbiddenProductionEdges.add('server/static:audit_unavailable');
        else if (checks.includes(true))
            forbiddenProductionEdges.add('server/static:changed');
    }
    if (options.skipSourceDistCheck !== true) {
        await auditSourceDist(root, readSource, sourceDistMismatches);
    }
    const freeze = (value) => Object.freeze([...value].sort());
    const result = {
        forbiddenFields: freeze(forbiddenFields),
        unsafeLoggerCalls: freeze(unsafeLoggerCalls),
        forbiddenTraceRedisCommands: freeze(forbiddenTraceRedisCommands),
        dynamicMetricDefinitions: freeze(dynamicMetricDefinitions),
        sourceDistMismatches: freeze(sourceDistMismatches),
        forbiddenProductionEdges: freeze(forbiddenProductionEdges)
    };
    return Object.freeze({
        ...result,
        passed: Object.values(result).every(values => values.length === 0)
    });
}
