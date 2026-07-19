import { MAX_CONTEXT_ARTIFACT_BYTES, MAX_CONTEXT_ARTIFACT_CONTENT_BYTES, MAX_CONTEXT_ARTIFACT_REFS } from './context-artifact.js';
export const CONTEXT_ARTIFACT_RESOURCE_LIMITS = Object.freeze({
    artifactBytes: MAX_CONTEXT_ARTIFACT_BYTES,
    contentBytes: MAX_CONTEXT_ARTIFACT_CONTENT_BYTES,
    sourceRefs: MAX_CONTEXT_ARTIFACT_REFS,
    namespaceKeys: 128,
    namespaceBytes: 2 * 1_024 * 1_024,
    minimumRemainingLifetimeMs: 1,
    maximumExpiryHorizonMs: 86_400_000,
    reconcileScanCount: 128,
    maxReconcileScanCalls: 2_048,
    maxReconcileDataKeys: 129,
    maxMetadataCasAttempts: 4,
    metadataBytes: 64
});
export function contextArtifactNamespaceUsageWithinLimits(keys, valueBytes) {
    return Number.isSafeInteger(keys) && keys >= 0 &&
        Number.isSafeInteger(valueBytes) && valueBytes >= 0 &&
        keys <= CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceKeys &&
        valueBytes <= CONTEXT_ARTIFACT_RESOURCE_LIMITS.namespaceBytes;
}
