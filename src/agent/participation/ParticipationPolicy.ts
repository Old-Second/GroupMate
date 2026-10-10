import { isTrustedParticipationEvent, type ParticipationDecision, type ParticipationEvent } from './ParticipationContract.js'

// Exact legacy probability semantics, including its -1 sentinel for explicit aliases.
export function legacyParticipationAllowed (input: Readonly<{
  explicitlyAddressed: boolean
  ratePercent: number
  sample: number | null
}>): boolean {
  if (input.explicitlyAddressed) return !(-1 >= input.ratePercent)
  if (input.sample === null || !Number.isFinite(input.sample) || input.sample < 0 || input.sample >= 1) return false
  return !(Math.floor(input.sample * 100) >= input.ratePercent)
}

export function decideParticipation (
  event: ParticipationEvent,
  input: Readonly<{ sampled: boolean; continuation: boolean }>
): ParticipationDecision {
  const decision = (kind: ParticipationDecision['kind'], source: ParticipationDecision['source'], reason: ParticipationDecision['reason']) =>
    Object.freeze({ kind, source, reason })
  if (!isTrustedParticipationEvent(event)) return decision('ignore', 'none', 'untrusted')
  if (!event.eligible) return decision('ignore', 'none', 'disabled')
  if (event.addressed) return decision('candidate', 'direct', 'direct')
  if (event.acknowledgement) return decision('ignore', 'none', 'acknowledgement')
  if (input.continuation) return decision('candidate', 'continuation', 'continuation')
  if (input.sampled) return decision('candidate', 'sampled', 'sampled')
  return decision('ignore', 'none', 'sample_miss')
}
