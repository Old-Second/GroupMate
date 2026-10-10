import type { ParticipationCandidate, ParticipationState } from './ParticipationState.js'

// P8A diagnostic fence only. Authoritative membership/effect checks belong to P8B.
export function candidateFreshness (state: ParticipationState, candidate: ParticipationCandidate): 'current' | 'obsolete' | 'unavailable' {
  try { return state.current(candidate) } catch { return 'unavailable' }
}
