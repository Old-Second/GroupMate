/**
 * Hard resource ceilings for one run. They are the outermost safety net, not
 * the effective conversation budget: the context budget derived from the
 * model window (see `deriveContextBudget`) is normally far smaller and decides
 * how much history a request actually replays.
 *
 * The byte ceilings are sized for long-context providers (1M tokens and more
 * exist), using the same `bytes / 4` token estimate the planner uses. A 1M
 * token request is roughly 4 MiB of JSON, so the request ceiling leaves room
 * for the envelope and a 2-4M token declaration.
 */
export const RUN_RESOURCE_LIMITS = Object.freeze({
  requestBytes: 16 * 1_024 * 1_024,
  sseLineBytes: 64 * 1_024,
  providerResponseBytes: 4 * 1_024 * 1_024,
  toolArgumentsBytes: 32 * 1_024,
  toolResultBytes: 64 * 1_024,
  providerStateBytes: 128 * 1_024,
  sanitizedErrorBodyBytes: 16 * 1_024,
  providerProtocolChainBytes: 8 * 1_024 * 1_024,
  checkpointBytes: 12 * 1_024 * 1_024,
  eventCount: 96,
  eventBytes: 128 * 1_024,
  // A long-context checkpoint alone may approach 12 MiB, so the namespace
  // budget covers checkpoint, events and references for one run.
  namespaceBytes: 32 * 1_024 * 1_024,
  tombstoneBytes: 4 * 1_024,
  checkpointKeys: 16,
  eventKeys: 16,
  // One day of ordinary traffic must not consume all terminal slots after 128 replies.
  // The namespace byte ceiling still bounds receipts and their lookup references.
  tombstoneKeys: 4_096,
  referenceKeys: 4_112,
  indexAdmissionKeys: 64
})

export type RunResourceLimits = typeof RUN_RESOURCE_LIMITS
