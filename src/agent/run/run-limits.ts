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
  tombstoneKeys: 128,
  referenceKeys: 144,
  indexAdmissionKeys: 64
})

export type RunResourceLimits = typeof RUN_RESOURCE_LIMITS
