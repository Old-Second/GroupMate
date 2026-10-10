import { PARTICIPATION_POLICY_VERSION, type ParticipationEvent, type ParticipationReason } from '../../agent/participation/ParticipationContract.js'
import { decideParticipation } from '../../agent/participation/ParticipationPolicy.js'
import { ParticipationState, type ParticipationCandidate } from '../../agent/participation/ParticipationState.js'

export interface ParticipationObservation {
  readonly schemaVersion: 1
  readonly policyVersion: 1
  readonly legacyAllowed: boolean
  readonly proposedAllowed: boolean
  readonly reason: ParticipationReason
  readonly disagreement: boolean
  readonly scopes: number
  readonly candidates: number
  readonly stateBytes: number
}

// No provider/tool/memory/outbound port can be acquired by this diagnostic component.
export class ParticipationShadow {
  readonly state: ParticipationState
  constructor (now: () => number, readonly record: (entry: ParticipationObservation) => void) {
    this.state = new ParticipationState(now)
  }

  compare (event: ParticipationEvent, legacyAllowed: boolean): ParticipationCandidate | null {
    try {
      const continuation = this.state.observe(event)
      const decision = decideParticipation(event, { sampled: legacyAllowed, continuation })
      const candidate = decision.kind === 'candidate' && decision.source !== 'none'
        ? this.state.offer(event, decision.source) : null
      const stats = this.state.stats()
      try {
        this.record(Object.freeze({ schemaVersion: 1, policyVersion: PARTICIPATION_POLICY_VERSION,
          legacyAllowed, proposedAllowed: candidate !== null, reason: decision.reason,
          disagreement: legacyAllowed !== (candidate !== null), scopes: stats.scopes,
          candidates: stats.candidates, stateBytes: stats.bytes }))
      } catch {}
      return candidate
    } catch { return null }
  }

  close (): void { this.state.close() }
}
