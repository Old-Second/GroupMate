export const RUN_RESOURCE_LIMITS = Object.freeze({
    requestBytes: 512 * 1_024,
    sseLineBytes: 64 * 1_024,
    providerResponseBytes: 1_024 * 1_024,
    toolArgumentsBytes: 32 * 1_024,
    toolResultBytes: 64 * 1_024,
    providerStateBytes: 128 * 1_024,
    sanitizedErrorBodyBytes: 16 * 1_024,
    providerProtocolChainBytes: 192 * 1_024,
    checkpointBytes: 256 * 1_024,
    eventCount: 96,
    eventBytes: 128 * 1_024,
    namespaceBytes: 8 * 1_024 * 1_024,
    tombstoneBytes: 4 * 1_024,
    checkpointKeys: 16,
    eventKeys: 16,
    // One day of ordinary traffic must not consume all terminal slots after 128 replies.
    // The existing 8 MiB byte ceiling still bounds receipts and their lookup references.
    tombstoneKeys: 4_096,
    referenceKeys: 4_112,
    indexAdmissionKeys: 64
});
