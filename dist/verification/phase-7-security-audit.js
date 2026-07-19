import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { auditPhase6SecurityBoundaries } from './phase-6-security-audit.js';
const MAX_AUDIT_FILE_BYTES = 2 * 1_024 * 1_024;
const FORBIDDEN_REDACTED_BODY_FIELDS = Object.freeze([
    'prompt',
    'messages',
    'message',
    'content',
    'text',
    'reasoning',
    'reasoningContent',
    'arguments',
    'argumentsText',
    'toolArguments',
    'toolResult',
    'result',
    'callId',
    'toolName',
    'userId',
    'user_id',
    'groupId',
    'group_id',
    'actorId',
    'botId',
    'selfId',
    'qq',
    'sender',
    'sessionId',
    'model',
    'endpoint',
    'apiKey',
    'token',
    'cookie',
    'authorization',
    'header',
    'headers'
]);
const REDACTED_SURFACE_FILES = Object.freeze([
    'src/runtime/observability/observation-event.ts',
    'src/runtime/observability/observation-hub.ts',
    'src/runtime/observability/metrics-registry.ts',
    'src/runtime/observability/run-observation-policy-gate.ts',
    'src/runtime/observability/safe-observation-logging.ts',
    'src/runtime/observability/trace-policy.ts',
    'src/runtime/observability/trace-record.ts',
    'src/runtime/observability/trace-recorder.ts',
    'src/runtime/observability/trace-store.ts',
    'src/runtime/observability/redis-trace-store.ts',
    'src/runtime/observability/owner-diagnostics.ts',
    'src/runtime/observability/trace-replay.ts',
    'src/runtime/yunzai-diagnostics-controller.ts',
    'src/runtime/request-observation.ts',
    'src/runtime/safe-chat-logging.ts',
    'src/agent/run/run-observation.ts',
    'src/agent/run/run-trace.ts'
]);
const REDACTED_EXACT_ALLOWLIST = Object.freeze({
    'src/runtime/observability/owner-diagnostics.ts': Object.freeze([
        'readonly text: string'
    ]),
    'src/runtime/observability/observation-event.ts': Object.freeze([
        'readonly text: string',
        'return parseRunTerminalSnapshot({\n    ...input,\n    completion: safeCompletion(input.completion),'
    ]),
    'src/runtime/request-observation.ts': Object.freeze([
        'return parseContext({ schemaVersion: 1, ...input }, false)'
    ]),
    'src/runtime/observability/trace-record.ts': Object.freeze([
        'return record'
    ])
});
const CONTENT_JOURNAL_FILES = Object.freeze([
    'src/agent/run/run-content-journal.ts',
    'src/runtime/logging/content-journal-outbound-projector.ts',
    'src/runtime/logging/content-journal-projection.ts',
    'src/runtime/logging/content-journal-request-run-projector.ts',
    'src/runtime/logging/groupmate-content-journal.ts',
    'src/runtime/logging/groupmate-disk-log.ts',
    'src/runtime/logging/journaled-yunzai-outbound.ts'
]);
const CONTENT_JOURNAL_PATH = 'src/agent/run/run-content-journal.ts';
const CONTENT_JOURNAL_PROJECTOR_PATH = 'src/runtime/logging/content-journal-request-run-projector.ts';
const PHASE_7_THIN_SCRIPTS = Object.freeze({
    'scripts/phase-7-resource-scenario.mjs': 'phase-7-resource-scenario.js',
    'scripts/measure-phase-7-resources.mjs': 'phase-7-resource-report.js',
    'scripts/verify-phase-7.mjs': 'phase-7-verification.js'
});
const GENERIC_CONTEXT_FILES = Object.freeze([
    'src/agent/context/context-planner.ts',
    'src/runtime/run-context-planner.ts',
    'src/agent/run/run-engine.ts',
    'src/runtime/agent-service.ts'
]);
const STANDARD_OPENAI_PROFILE_PATH = 'src/agent/model/standard-openai-profile.ts';
function normalizeRelativePath(value) {
    const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
    if (normalized === '' || normalized.startsWith('/') || normalized.includes('../') ||
        normalized.includes('\0'))
        throw new TypeError('Phase 7 security audit path is invalid');
    return normalized;
}
function validateRoot(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError('Phase 7 security audit project root is invalid');
    }
    return path.resolve(value);
}
function validateOverrides(value) {
    if (value === undefined)
        return Object.freeze({});
    const result = {};
    for (const [rawPath, source] of Object.entries(value)) {
        const relativePath = normalizeRelativePath(rawPath);
        if (typeof source !== 'string' ||
            Buffer.byteLength(source, 'utf8') > MAX_AUDIT_FILE_BYTES) {
            throw new TypeError('Phase 7 security audit source override is invalid');
        }
        result[relativePath] = source;
    }
    return Object.freeze(result);
}
function finding(target, relativePath, code) {
    target.add(`${relativePath}:${code}`);
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function exactThinScript(source, target) {
    return new RegExp(`^import \\{ main \\} from '../dist/verification/${escapeRegex(target)}';?\\nawait main\\(\\);?\\n?$`).test(source);
}
function methodSection(source, start, end) {
    const startIndex = source.indexOf(start);
    const endIndex = source.indexOf(end, startIndex + start.length);
    return startIndex < 0 || endIndex < 0 ? '' : source.slice(startIndex, endIndex);
}
function auditProviderIsolationSurface(relativePath, source, findings) {
    if (/\bcacheIsolationId\b/.test(source)) {
        finding(findings, relativePath, 'cache_isolation_id');
    }
    if (/\buser_id\b/.test(source))
        finding(findings, relativePath, 'user_id');
    if (/\bgm_[gu]_[A-Za-z0-9_-]+\b/.test(source)) {
        finding(findings, relativePath, 'derived_isolation_id');
    }
    if (/provider-isolation\.key|ProviderRequestMetadata/.test(source)) {
        finding(findings, relativePath, 'provider_isolation_material');
    }
}
function auditRedactedBodySurface(relativePath, source, findings) {
    let surface = source;
    for (const allowed of REDACTED_EXACT_ALLOWLIST[relativePath] ?? []) {
        const index = surface.indexOf(allowed);
        if (index < 0) {
            finding(findings, relativePath, 'allowlist_drift');
            continue;
        }
        surface = `${surface.slice(0, index)}${' '.repeat(allowed.length)}${surface.slice(index + allowed.length)}`;
    }
    for (const field of FORBIDDEN_REDACTED_BODY_FIELDS) {
        const escaped = escapeRegex(field);
        const persistedField = new RegExp(`\\breadonly\\s+(?:['"])?${escaped}(?:['"])?\\s*[?:]`);
        const rawProjection = new RegExp(`(?:^|[,{}\\n])\\s*(?:['"])?${escaped}(?:['"])?\\s*:\\s*` +
            '(?:request|checkpoint|event|record|artifact|trace|input)\\b', 'm');
        if (persistedField.test(surface) || rawProjection.test(surface)) {
            finding(findings, relativePath, field);
        }
    }
    if (/\.\.\.\s*(?:request|checkpoint|event|record|artifact|trace|input)\b(?!\s*\.)/.test(surface)) {
        finding(findings, relativePath, 'raw_spread');
    }
    if (/\breturn\s+(?:request|checkpoint|event|record|artifact|trace|input)\b(?!\s*\.)/.test(surface)) {
        finding(findings, relativePath, 'raw_return');
    }
}
function auditContextArtifactSurface(relativePath, source, findings) {
    if (/\bContextArtifact(?:Draft)?V1\b/.test(source)) {
        finding(findings, relativePath, 'artifact_value_type');
    }
    if (/\b(?:artifact|artifactValue|contextArtifact)\s*(?:\.|\?\.)\s*content\b/.test(source)) {
        finding(findings, relativePath, 'artifact_content_access');
    }
    if (/\bCONTEXT_ARTIFACT_SAFE_PREFIX\b/.test(source)) {
        finding(findings, relativePath, 'artifact_content_prefix');
    }
    if (/\b(?:encode|decode|create|parse)ContextArtifactV1\b/.test(source)) {
        finding(findings, relativePath, 'artifact_value_codec');
    }
}
function auditContentJournal(source, findings) {
    if (source === null) {
        finding(findings, CONTENT_JOURNAL_PATH, 'missing');
        return;
    }
    if (!/export\s+type\s+JournalModelRequest\s*=\s*Omit\s*<\s*ModelRequest\s*,\s*['"]metadata['"]\s*>/.test(source)) {
        finding(findings, CONTENT_JOURNAL_PATH, 'provider_metadata_projection');
    }
    const snapshot = methodSection(source, 'export function snapshotModelRequestForJournal (', 'export function snapshotModelTurnForJournal (');
    if (!/const\s+projected\s*:\s*JournalModelRequest\s*=\s*Object\.freeze\s*\(\s*\{/.test(snapshot) ||
        /\.\.\.\s*request\b|request\.metadata|\bmetadata\s*:|\bcacheIsolationId\b|\buser_id\b/.test(snapshot)) {
        finding(findings, CONTENT_JOURNAL_PATH, 'provider_metadata_projection');
    }
    if (!/\bmessages\s*:\s*request\.messages\b/.test(snapshot)) {
        finding(findings, CONTENT_JOURNAL_PATH, 'complete_model_messages');
    }
}
function auditContentJournalProjector(source, findings) {
    if (source === null) {
        finding(findings, CONTENT_JOURNAL_PROJECTOR_PATH, 'missing');
        return;
    }
    const parser = methodSection(source, 'function parseModelRequest (', 'function parseModelTurn (');
    if (parser === '' || /\bmetadata\b|\bcacheIsolationId\b|\buser_id\b/.test(parser)) {
        finding(findings, CONTENT_JOURNAL_PROJECTOR_PATH, 'provider_metadata_projection');
    }
    if (!/jsonArray\s*\(\s*input\.messages\s*,/.test(parser)) {
        finding(findings, CONTENT_JOURNAL_PROJECTOR_PATH, 'complete_model_messages');
    }
}
export async function auditPhase7SecurityBoundaries(projectRoot, options = {}) {
    const root = validateRoot(projectRoot);
    const overrides = validateOverrides(options.sourceOverrides);
    const phase6 = await auditPhase6SecurityBoundaries(root, options);
    const forbiddenRedactedBodyFields = new Set();
    const forbiddenProviderIsolationLeaks = new Set();
    const forbiddenContextArtifactLeaks = new Set();
    const invalidContentJournalBoundaries = new Set();
    const forbiddenPhase7Edges = new Set();
    const readSource = async (rawPath) => {
        const relativePath = normalizeRelativePath(rawPath);
        if (Object.hasOwn(overrides, relativePath))
            return overrides[relativePath];
        try {
            const value = await readFile(path.join(root, relativePath), 'utf8');
            if (Buffer.byteLength(value, 'utf8') > MAX_AUDIT_FILE_BYTES) {
                finding(forbiddenPhase7Edges, relativePath, 'oversized');
                return null;
            }
            return value;
        }
        catch {
            return null;
        }
    };
    for (const relativePath of REDACTED_SURFACE_FILES) {
        const source = await readSource(relativePath);
        if (source === null) {
            finding(forbiddenPhase7Edges, relativePath, 'missing');
            continue;
        }
        auditRedactedBodySurface(relativePath, source, forbiddenRedactedBodyFields);
        auditProviderIsolationSurface(relativePath, source, forbiddenProviderIsolationLeaks);
        auditContextArtifactSurface(relativePath, source, forbiddenContextArtifactLeaks);
    }
    for (const relativePath of CONTENT_JOURNAL_FILES) {
        const source = await readSource(relativePath);
        if (source === null) {
            finding(forbiddenPhase7Edges, relativePath, 'missing');
            continue;
        }
        auditProviderIsolationSurface(relativePath, source, forbiddenProviderIsolationLeaks);
    }
    auditContentJournal(await readSource(CONTENT_JOURNAL_PATH), invalidContentJournalBoundaries);
    auditContentJournalProjector(await readSource(CONTENT_JOURNAL_PROJECTOR_PATH), invalidContentJournalBoundaries);
    for (const [relativePath, target] of Object.entries(PHASE_7_THIN_SCRIPTS)) {
        const script = await readSource(relativePath);
        if (script === null || !exactThinScript(script, target)) {
            finding(forbiddenPhase7Edges, relativePath, 'not_thin');
        }
    }
    for (const relativePath of GENERIC_CONTEXT_FILES) {
        const source = await readSource(relativePath);
        if (source === null) {
            finding(forbiddenPhase7Edges, relativePath, 'missing');
        }
        else if (/deepseek/i.test(source)) {
            finding(forbiddenPhase7Edges, relativePath, 'provider_specific_context');
        }
    }
    const standardProfile = await readSource(STANDARD_OPENAI_PROFILE_PATH);
    if (standardProfile === null ||
        !/cacheIsolation\s*:\s*['"]none['"]/.test(standardProfile) ||
        !/encodeRequestMetadata\s*:\s*\(\)\s*=>\s*EMPTY_OBJECT/.test(standardProfile) ||
        /\buser_id\b|\bcacheIsolationId\b/.test(standardProfile)) {
        finding(forbiddenPhase7Edges, STANDARD_OPENAI_PROFILE_PATH, 'standard_metadata_neutrality');
    }
    const freeze = (value) => Object.freeze([...value].sort());
    const { passed: phase6Passed, ...phase6Findings } = phase6;
    const incremental = {
        forbiddenRedactedBodyFields: freeze(forbiddenRedactedBodyFields),
        forbiddenProviderIsolationLeaks: freeze(forbiddenProviderIsolationLeaks),
        forbiddenContextArtifactLeaks: freeze(forbiddenContextArtifactLeaks),
        invalidContentJournalBoundaries: freeze(invalidContentJournalBoundaries),
        forbiddenPhase7Edges: freeze(forbiddenPhase7Edges)
    };
    return Object.freeze({
        ...phase6Findings,
        ...incremental,
        passed: phase6Passed && Object.values(incremental).every(values => values.length === 0)
    });
}
