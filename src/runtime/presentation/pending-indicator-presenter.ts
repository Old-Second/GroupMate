import type { FinalPresentationProfile } from './presentation-profile.js'
import { plainTextPart } from './text-presentation.js'
import {
  deliverWithDefiniteRetry,
  type YunzaiOutboundPort
} from './yunzai-outbound-port.js'

export const PENDING_INDICATOR_TEXT = '我正在思考如何回复你，请稍等'

export type PendingIndicatorDismissReason =
  | 'progress'
  | 'paused'
  | 'terminal'
  | 'timeout'

export interface PendingIndicatorHandle {
  readonly runRef: string
  dismiss(reason: PendingIndicatorDismissReason): Promise<void>
}

export interface PendingIndicatorPresenterOptions {
  readonly autoDismissMs?: number
  readonly setTimer?: typeof setTimeout
  readonly clearTimer?: typeof clearTimeout
  readonly onDeliveryFailure?: (failure: Readonly<{
    event: 'run.pending.delivery_failed'
    runRef: string
    resultCode: string
  }>) => void
}

export class PendingIndicatorPresenter {
  readonly #autoDismissMs: number
  readonly #setTimer: typeof setTimeout
  readonly #clearTimer: typeof clearTimeout
  readonly #onDeliveryFailure?: PendingIndicatorPresenterOptions['onDeliveryFailure']

  constructor (options: PendingIndicatorPresenterOptions = {}) {
    const autoDismissMs = options.autoDismissMs ?? 8_000
    if (!Number.isSafeInteger(autoDismissMs) || autoDismissMs < 1 || autoDismissMs > 8_000) {
      throw new TypeError('pending indicator timeout is invalid')
    }
    this.#autoDismissMs = autoDismissMs
    this.#setTimer = options.setTimer ?? setTimeout
    this.#clearTimer = options.clearTimer ?? clearTimeout
    this.#onDeliveryFailure = options.onDeliveryFailure
  }

  async show (input: {
    readonly runRef: string
    readonly outbound: YunzaiOutboundPort
    readonly profile: FinalPresentationProfile
    readonly enabled: boolean
    readonly signal?: AbortSignal
  }): Promise<PendingIndicatorHandle | null> {
    if (input.profile.kind !== 'ordinary' || input.enabled !== true) return null
    const attempts = await deliverWithDefiniteRetry(
      input.outbound,
      plainTextPart(PENDING_INDICATOR_TEXT),
      input.signal === undefined ? undefined : { signal: input.signal }
    )
    const final = attempts.at(-1)
    if (final?.kind !== 'sent') {
      try {
        this.#onDeliveryFailure?.(Object.freeze({
          event: 'run.pending.delivery_failed',
          runRef: input.runRef,
          resultCode: final?.kind ?? 'no_result'
        }))
      } catch {}
      return null
    }

    const outbound = input.outbound
    const receipt = final.receipt
    const runRef = input.runRef
    const clearTimer = this.#clearTimer
    const setTimer = this.#setTimer
    const autoDismissMs = this.#autoDismissMs
    let terminal = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let dismissing: Promise<void> | undefined
    const handle: PendingIndicatorHandle = Object.freeze({
      runRef,
      dismiss: async (_reason: PendingIndicatorDismissReason): Promise<void> => {
        if (dismissing !== undefined) return await dismissing
        if (terminal) return
        terminal = true
        if (timer !== undefined) {
          clearTimer(timer)
          timer = undefined
        }
        dismissing = Promise.resolve().then(
          async () => await outbound.recall(receipt)
        ).then(
          () => undefined,
          () => undefined
        )
        await dismissing
      }
    })
    timer = setTimer(() => {
      if (!terminal && handle.runRef === runRef) {
        void handle.dismiss('timeout').catch(() => undefined)
      }
    }, autoDismissMs)
    timer.unref?.()
    return handle
  }
}
