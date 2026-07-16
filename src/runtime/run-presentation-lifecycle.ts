import type {
  PresentationRouteV1,
  RecoveredLegacyPresentationRoute
} from '../agent/contracts/interaction.js'
import type { FrozenObservationPolicyV1 } from '../agent/run/run-observation.js'
import type { FinalPresentationProfile } from './presentation/presentation-profile.js'
import type {
  PendingIndicatorHandle,
  PendingIndicatorPresenter
} from './presentation/pending-indicator-presenter.js'
import type { YunzaiOutboundPortFactory } from './presentation/yunzai-outbound-port.js'
import type { RunProgressPresenter } from './run-progress-presenter.js'
import type { ProgressResumeState } from './run-progress-presenter.js'

export interface RunPresentationLifecycle {
  onRunStarted(input: {
    readonly runId: string
    readonly runRef: string
    readonly observationPolicy: FrozenObservationPolicyV1
    readonly progressResume?: ProgressResumeState
  }): Promise<void>

  onRunSettled(input: {
    readonly runId: string
    readonly status: 'paused' | 'terminal'
  }): Promise<void>
}

export function createRunPresentationLifecycle (input: {
  readonly route: PresentationRouteV1 | RecoveredLegacyPresentationRoute
  readonly profile: FinalPresentationProfile
  readonly pendingEnabled: boolean
  readonly outboundFactory: YunzaiOutboundPortFactory
  readonly pending: PendingIndicatorPresenter
  readonly progress: RunProgressPresenter
}): RunPresentationLifecycle {
  let startedRunId: string | undefined
  let indicator: PendingIndicatorHandle | null = null
  let settlePromise: Promise<void> | undefined

  return Object.freeze({
    async onRunStarted (
      started: Parameters<RunPresentationLifecycle['onRunStarted']>[0]
    ): Promise<void> {
      if (startedRunId !== undefined) return
      startedRunId = started.runId
      const outbound = await input.outboundFactory.forTarget(input.route.sessionAddress)
      indicator = await input.pending.show({
        runRef: started.runRef,
        outbound,
        profile: input.profile,
        enabled: input.pendingEnabled
      })
      input.progress.attach(Object.freeze({
        runId: started.runId,
        runRef: started.runRef,
        requestKind: input.route.requestKind === 'legacy_unknown'
          ? 'recovered_legacy_plain_text'
          : input.route.requestKind,
        observationPolicy: started.observationPolicy,
        resume: started.progressResume ?? Object.freeze({
          attempts: 0,
          seenStages: Object.freeze([])
        }),
        outbound,
        indicator
      }))
    },

    async onRunSettled (
      settled: Parameters<RunPresentationLifecycle['onRunSettled']>[0]
    ): Promise<void> {
      if (startedRunId === undefined || settled.runId !== startedRunId) return
      if (settlePromise === undefined) {
        settlePromise = (async () => {
          try {
            await indicator?.dismiss(settled.status === 'paused' ? 'paused' : 'terminal')
          } catch {}
          try {
            await input.progress.drain(settled.runId)
          } catch {}
          try {
            input.progress.detach(settled.runId)
          } catch {}
        })()
      }
      await settlePromise
    }
  })
}
