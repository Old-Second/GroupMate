import type { PresentationResult } from './presentation/presentation-result.js'
import type { SessionPersistenceOutcome } from '../agent/contracts/completion.js'
import type { FinalRunResult } from './runtime-presentation-hooks.js'
import {
  projectFinalPresentation,
  type FinalChatReplyEnvelope
} from './agent-service.js'
import {
  finalizeRequestObservation,
  type RequestObservationV1
} from './request-observation.js'

export interface RequestObservationPublisher {
  publish(observation: RequestObservationV1): void | Promise<void>
}

export interface FinalPresentationProjection {
  readonly result: FinalRunResult
  readonly sessionPersistence: SessionPersistenceOutcome
}

export interface PresentationCompletionCoordinator {
  complete(input: {
    readonly envelope: FinalChatReplyEnvelope
    readonly present: (
      projection: FinalPresentationProjection
    ) => Promise<PresentationResult>
  }): Promise<PresentationResult>
}

export class RequestObservationAlreadyCompletedError extends Error {
  constructor () {
    super('request observation draft was already completed')
    this.name = 'RequestObservationAlreadyCompletedError'
  }
}

function safeMonotonicNow (
  clock: () => number | 'unavailable'
): number | 'unavailable' {
  try {
    const value = clock()
    return value === 'unavailable' ||
      (Number.isSafeInteger(value) && value >= 0)
      ? value
      : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

export function createPresentationCompletionCoordinator (input: {
  readonly publisher: RequestObservationPublisher
  readonly monotonicNow: () => number | 'unavailable'
  readonly onPublishFailure?: (
    code: 'request_observation_publish_failed'
  ) => void
}): PresentationCompletionCoordinator {
  const completed = new WeakSet<object>()
  return Object.freeze({
    async complete ({ envelope, present }: {
      readonly envelope: FinalChatReplyEnvelope
      readonly present: (
        projection: FinalPresentationProjection
      ) => Promise<PresentationResult>
    }) {
      const draft = envelope.requestObservationDraft
      if (draft === null || typeof draft !== 'object') {
        throw new TypeError('final request observation draft is invalid')
      }
      if (completed.has(draft)) {
        throw new RequestObservationAlreadyCompletedError()
      }
      completed.add(draft)
      try {
        const projection = projectFinalPresentation(envelope)
        return await present(projection)
      } finally {
        const observation = finalizeRequestObservation({
          draft,
          finishedAtMonotonicMs: safeMonotonicNow(input.monotonicNow)
        })
        try {
          await input.publisher.publish(observation)
        } catch {
          try {
            input.onPublishFailure?.('request_observation_publish_failed')
          } catch {
            // Observation reporting is outside the presentation control plane.
          }
        }
      }
    }
  })
}
