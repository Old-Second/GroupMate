import { createHash } from 'node:crypto';
import { parseMemorySourceV1, parseQqIdentitySnapshotV1 } from './memory-domain.js';
import { parseMemoryLifecycleInstantV1 } from './memory-lifecycle-domain.js';
import { inspectMemoryArray, inspectMemoryRecord, invalidMemoryValue, memoryNamespaceRefV1, parseMemoryNamespaceV1 } from './memory-namespace.js';
import { MEMORY_RESOURCE_LIMITS, memoryAsciiWithinLimit, memoryCanonicalTextWithinLimits, memoryTextWithinLimits } from './memory-resource-limits.js';
export const MEMORY_EXTRACTION_JOB_HASH_DOMAIN_V1 = 'groupmate.memory.extraction-job.v1';
const MEMORY_KINDS = Object.freeze([
    'profile_fact', 'preference', 'relationship', 'group_rule', 'group_culture',
    'task_fact', 'other'
]);
const MEMORY_SENSITIVITIES = Object.freeze([
    'public', 'group', 'personal', 'sensitive'
]);
const EXTRACTION_MODES = Object.freeze([
    'shadow', 'automatic'
]);
const EXTRACTION_PRIORITIES = Object.freeze([
    'asserted', 'inferred'
]);
const CANDIDATE_DERIVATIONS = Object.freeze([
    'stated', 'inferred'
]);
const MAXIMUM_EXTRACTED_CANDIDATES = 4;
const MAXIMUM_EXTRACTOR_ID_BYTES = 128;
const MAXIMUM_ASSISTANT_REPLY_BYTES = 4 * 1_024;
const MAXIMUM_ASSISTANT_REPLY_CODE_POINTS = 2_000;
function enumValue(value, values) {
    if (typeof value !== 'string' || !values.includes(value))
        return invalidMemoryValue();
    return value;
}
function positiveInteger(value) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 ||
        Object.is(value, -0))
        return invalidMemoryValue();
    return value;
}
function confidence(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        return invalidMemoryValue();
    }
    return value;
}
function exactHash(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
        return invalidMemoryValue();
    return value;
}
function opaqueId(value, prefix = null) {
    if (!memoryAsciiWithinLimit(value, MAXIMUM_EXTRACTOR_ID_BYTES) || value.length === 0 ||
        (prefix !== null && (!value.startsWith(prefix) || value.length === prefix.length))) {
        return invalidMemoryValue();
    }
    return value;
}
function assistantReply(value) {
    if (!memoryCanonicalTextWithinLimits(value, MAXIMUM_ASSISTANT_REPLY_BYTES, MAXIMUM_ASSISTANT_REPLY_CODE_POINTS) || value.trim() === '')
        return invalidMemoryValue();
    return value;
}
function jobPreimage(value) {
    return JSON.stringify({
        namespace: value.namespace,
        namespaceRef: value.namespaceRef,
        namespaceGeneration: value.namespaceGeneration,
        subject: value.subject,
        source: value.source,
        sceneRef: value.sceneRef,
        sourceRunRef: value.sourceRunRef,
        sourceModelProfile: value.sourceModelProfile,
        requestedMode: value.requestedMode,
        priority: value.priority,
        enqueuedAt: value.enqueuedAt,
        assistantReply: value.assistantReply
    });
}
function deriveJobId(value) {
    return `extraction:${createHash('sha256')
        .update(MEMORY_EXTRACTION_JOB_HASH_DOMAIN_V1, 'utf8')
        .update('\0')
        .update(jobPreimage(value), 'utf8')
        .digest('hex')}`;
}
function parseJobFields(value, includeComputed) {
    const fields = [
        'namespace', 'namespaceGeneration', 'subject', 'source', 'sceneRef', 'sourceRunRef',
        'sourceModelProfile', 'requestedMode', 'priority', 'enqueuedAt', 'assistantReply'
    ];
    const input = inspectMemoryRecord(value, includeComputed ? ['schemaVersion', 'jobId', 'namespaceRef', ...fields] : fields);
    if (includeComputed && input.schemaVersion !== 1)
        return invalidMemoryValue();
    const namespace = parseMemoryNamespaceV1(input.namespace);
    if (namespace.scope.kind !== 'personal')
        return invalidMemoryValue();
    const namespaceRef = memoryNamespaceRefV1(namespace);
    const subject = parseQqIdentitySnapshotV1(input.subject);
    const source = parseMemorySourceV1(input.source);
    if (subject.userId !== namespace.scope.subjectUserId)
        return invalidMemoryValue();
    const withoutComputed = Object.freeze({
        namespace,
        namespaceRef,
        namespaceGeneration: positiveInteger(input.namespaceGeneration),
        subject,
        source,
        sceneRef: exactHash(input.sceneRef),
        sourceRunRef: opaqueId(input.sourceRunRef, 'run:'),
        sourceModelProfile: opaqueId(input.sourceModelProfile),
        requestedMode: enumValue(input.requestedMode, EXTRACTION_MODES),
        priority: enumValue(input.priority, EXTRACTION_PRIORITIES),
        enqueuedAt: parseMemoryLifecycleInstantV1(input.enqueuedAt),
        assistantReply: assistantReply(input.assistantReply)
    });
    const jobId = deriveJobId(withoutComputed);
    if (includeComputed && (input.jobId !== jobId || input.namespaceRef !== namespaceRef))
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        jobId,
        ...withoutComputed
    });
}
export function createMemoryExtractionJobV1(value) {
    return parseJobFields(value, false);
}
export function parseMemoryExtractionJobV1(value) {
    return parseJobFields(value, true);
}
export function encodeMemoryExtractionJobV1(value) {
    const wire = JSON.stringify(parseMemoryExtractionJobV1(value));
    return wire;
}
export function decodeMemoryExtractionJobV1(value) {
    if (typeof value !== 'string')
        return invalidMemoryValue();
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        return invalidMemoryValue();
    }
    const job = parseMemoryExtractionJobV1(parsed);
    if (JSON.stringify(job) !== value)
        return invalidMemoryValue();
    return job;
}
function parseCandidate(value, job) {
    const input = inspectMemoryRecord(value, [
        'kind', 'text', 'sourceIds', 'derivation', 'confidence', 'sensitivity'
    ]);
    if (!memoryTextWithinLimits(input.text) || input.text.trim() === '')
        return invalidMemoryValue();
    const sourceIds = inspectMemoryArray(input.sourceIds, MEMORY_RESOURCE_LIMITS.sources)
        .map(exactHash);
    if (sourceIds.length === 0 || new Set(sourceIds).size !== sourceIds.length ||
        sourceIds.some(sourceId => sourceId !== job.source.sourceId))
        return invalidMemoryValue();
    return Object.freeze({
        kind: enumValue(input.kind, MEMORY_KINDS),
        text: input.text,
        sourceIds: Object.freeze(sourceIds),
        derivation: enumValue(input.derivation, CANDIDATE_DERIVATIONS),
        confidence: confidence(input.confidence),
        sensitivity: enumValue(input.sensitivity, MEMORY_SENSITIVITIES)
    });
}
export function parseMemoryExtractorResultV1(value, jobValue) {
    const job = parseMemoryExtractionJobV1(jobValue);
    const discriminator = inspectMemoryRecord(value, ['schemaVersion', 'status', 'extractorVersion', 'modelProfile'], ['reason', 'candidates']);
    if (discriminator.schemaVersion !== 1)
        return invalidMemoryValue();
    const extractorVersion = opaqueId(discriminator.extractorVersion);
    const modelProfile = opaqueId(discriminator.modelProfile);
    if (discriminator.status === 'no_op') {
        const input = inspectMemoryRecord(value, [
            'schemaVersion', 'status', 'extractorVersion', 'modelProfile', 'reason'
        ]);
        return Object.freeze({
            schemaVersion: 1,
            status: 'no_op',
            extractorVersion,
            modelProfile,
            reason: enumValue(input.reason, [
                'no_durable_fact', 'insufficient_evidence'
            ])
        });
    }
    if (discriminator.status !== 'candidates')
        return invalidMemoryValue();
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'status', 'extractorVersion', 'modelProfile', 'candidates'
    ]);
    const candidates = inspectMemoryArray(input.candidates, MAXIMUM_EXTRACTED_CANDIDATES)
        .map(candidate => parseCandidate(candidate, job));
    if (candidates.length === 0)
        return invalidMemoryValue();
    return Object.freeze({
        schemaVersion: 1,
        status: 'candidates',
        extractorVersion,
        modelProfile,
        candidates: Object.freeze(candidates)
    });
}
export function deriveMemoryCandidateProvenanceV1(jobValue, candidateValue) {
    const job = parseMemoryExtractionJobV1(jobValue);
    const candidate = parseCandidate(candidateValue, job);
    const sourceActorUserIds = Object.freeze([job.source.actor.userId]);
    return Object.freeze({
        schemaVersion: 1,
        subjectUserId: job.subject.userId,
        sourceActorUserIds,
        speakerRelation: job.source.actor.userId === job.subject.userId
            ? 'self'
            : 'third_party',
        derivation: candidate.derivation,
        sourceIds: candidate.sourceIds
    });
}
const AUTHORIZATION_PATTERN = /(?:authorization\s*[:=]\s*(?:bearer|basic)\s+\S{6,}|bearer\s+[A-Za-z0-9._~+/=-]{8,})/iu;
const COOKIE_PATTERN = /(?:cookie|set-cookie|session[_ -]?id|会话(?:令牌|标识))\s*[:=：]\s*\S{6,}/iu;
const PASSWORD_PATTERN = /(?:password|passwd|pwd|密码|登录口令)\s*(?:是|为|[:=：])\s*\S{4,}/iu;
const VERIFICATION_CODE_PATTERN = /(?:验证码|校验码|动态口令|otp|verification\s*code)\s*(?:是|为|[:=：])?\s*\d{4,8}\b/iu;
const API_KEY_PATTERN = /(?:\bsk-[A-Za-z0-9_-]{8,}|(?:api[ _-]*key|secret[ _-]*key|api\s*密钥|接口密钥)\s*(?:是|为|[:=：])\s*\S{6,})/iu;
export function memoryCredentialRejectionReasonV1(value) {
    if (typeof value !== 'string')
        return invalidMemoryValue();
    if (AUTHORIZATION_PATTERN.test(value))
        return 'authorization';
    if (COOKIE_PATTERN.test(value))
        return 'cookie';
    if (PASSWORD_PATTERN.test(value))
        return 'password';
    if (VERIFICATION_CODE_PATTERN.test(value))
        return 'verification_code';
    if (API_KEY_PATTERN.test(value))
        return 'api_key';
    return null;
}
const LOW_VALUE_TEXT = new Set([
    '好', '好的', '收到', '谢谢', '感谢', '嗯', '哦', '哈哈', '在吗', '没事',
    '不知道', '没有', '可以', '行'
]);
export function memoryCandidateValueRejectionReasonV1(jobValue, candidateValue) {
    const job = parseMemoryExtractionJobV1(jobValue);
    const candidate = parseCandidate(candidateValue, job);
    if (memoryCredentialRejectionReasonV1(candidate.text) !== null ||
        memoryCredentialRejectionReasonV1(job.source.normalizedText) !== null ||
        memoryCredentialRejectionReasonV1(job.assistantReply) !== null) {
        return 'credential';
    }
    const trimmed = candidate.text.trim();
    if (LOW_VALUE_TEXT.has(trimmed) || /[?？]$/u.test(trimmed) ||
        Array.from(trimmed).filter(character => /[\p{L}\p{N}]/u.test(character)).length < 2) {
        return 'no_durable_value';
    }
    if (candidate.confidence < 0.55)
        return 'low_confidence';
    return null;
}
export function memoryCandidateHashV1(jobValue, candidateValue) {
    const job = parseMemoryExtractionJobV1(jobValue);
    const candidate = parseCandidate(candidateValue, job);
    return createHash('sha256')
        .update('groupmate.memory.extracted-candidate.v1', 'utf8')
        .update('\0')
        .update(JSON.stringify(candidate), 'utf8')
        .digest('hex');
}
export function memoryCandidateProvenanceHashV1(value) {
    const input = inspectMemoryRecord(value, [
        'schemaVersion', 'subjectUserId', 'sourceActorUserIds', 'speakerRelation',
        'derivation', 'sourceIds'
    ]);
    if (input.schemaVersion !== 1)
        return invalidMemoryValue();
    const sourceActorUserIds = inspectMemoryArray(input.sourceActorUserIds, MEMORY_RESOURCE_LIMITS.sources).map(item => {
        if (typeof item !== 'string' || !/^\d+$/.test(item))
            return invalidMemoryValue();
        return item;
    });
    const sourceIds = inspectMemoryArray(input.sourceIds, MEMORY_RESOURCE_LIMITS.sources)
        .map(exactHash);
    const canonical = Object.freeze({
        schemaVersion: 1,
        subjectUserId: typeof input.subjectUserId === 'string' && /^\d+$/.test(input.subjectUserId)
            ? input.subjectUserId
            : invalidMemoryValue(),
        sourceActorUserIds: Object.freeze(sourceActorUserIds),
        speakerRelation: enumValue(input.speakerRelation, ['self', 'third_party']),
        derivation: enumValue(input.derivation, CANDIDATE_DERIVATIONS),
        sourceIds: Object.freeze(sourceIds)
    });
    return createHash('sha256')
        .update('groupmate.memory.candidate-provenance.v1', 'utf8')
        .update('\0')
        .update(JSON.stringify(canonical), 'utf8')
        .digest('hex');
}
