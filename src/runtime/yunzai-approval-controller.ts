import type { SessionAddress } from '../agent/contracts/identity.js'
import type { FinalChatReplyEnvelope, PausedChatReplyEnvelope } from './agent-service.js'
import type { YunzaiMessageEvent } from './agent-service-bridge.js'
import type { DeliveryResult, PresentationResult } from './presentation/presentation-result.js'
import {
  deliverWithDefiniteRetry,
  type YunzaiOutboundPortFactory
} from './presentation/yunzai-outbound-port.js'
import { plainTextPart } from './presentation/text-presentation.js'
import type {
  FinalPresentationProjection,
  PresentationCompletionCoordinator
} from './request-observation-completion.js'
import {
  APPROVAL_RECOVERY_DEFERRED_MESSAGE,
  type ActivePresentationContext,
  type ApprovalReference,
  type ApprovalReplyProjection,
  type ApprovalRouteOutcome,
  type ApprovalRouteResultHandler
} from './run-approval-router.js'

export interface ApprovalControlPresenter {
  presentRecoveryDeferred(input: {
    readonly approvalAddress: SessionAddress
    readonly signal?: AbortSignal
  }): Promise<readonly DeliveryResult<'text'>[]>
}

export interface ApprovalReplyProjector {
  project(event: YunzaiMessageEvent): Promise<ApprovalReplyProjection | null>
}

export interface ApprovalRouterPort {
  route(
    reply: ApprovalReplyProjection,
    onResult?: ApprovalRouteResultHandler
  ): Promise<boolean>
}

export interface ApprovalPausedHandler {
  handle(input: {
    readonly result: PausedChatReplyEnvelope
    readonly reference: ApprovalReference
    readonly context: ActivePresentationContext
  }): Promise<void>
}

export interface ApprovalTerminalPresenter {
  present(input: {
    readonly route: ActivePresentationContext['route']
    readonly projection: FinalPresentationProjection
  }): Promise<PresentationResult>
}

export interface YunzaiApprovalController {
  confirmToolOperation(event: YunzaiMessageEvent): Promise<boolean>
}

export interface YunzaiApprovalControllerOptions {
  readonly projector: ApprovalReplyProjector
  readonly router: ApprovalRouterPort
  readonly controlPresenter: ApprovalControlPresenter
  readonly pausedHandler: ApprovalPausedHandler
  readonly terminalPresenter: ApprovalTerminalPresenter
  readonly completionCoordinator: PresentationCompletionCoordinator
  readonly outcomeHandler?: ApprovalRouteResultHandler
}

export function createApprovalControlPresenter (input: {
  readonly outboundFactory: YunzaiOutboundPortFactory
}): ApprovalControlPresenter {
  return Object.freeze({
    async presentRecoveryDeferred ({ approvalAddress, signal }: {
      readonly approvalAddress: SessionAddress
      readonly signal?: AbortSignal
    }): Promise<readonly DeliveryResult<'text'>[]> {
      const outbound = await input.outboundFactory.forTarget(approvalAddress)
      return await deliverWithDefiniteRetry(
        outbound,
        plainTextPart(APPROVAL_RECOVERY_DEFERRED_MESSAGE),
        signal === undefined ? undefined : { signal }
      )
    }
  })
}

export function createApprovalOutcomeHandler (
  options: Omit<YunzaiApprovalControllerOptions, 'outcomeHandler'>
): ApprovalRouteResultHandler {
  return async (
    result: ApprovalRouteOutcome,
    reference: ApprovalReference,
    context: ActivePresentationContext
  ): Promise<void> => {
    if (result.kind === 'approval_deferred') {
      try {
        await options.controlPresenter.presentRecoveryDeferred({
          approvalAddress: reference.approvalAddress
        })
      } catch {}
      return
    }
    if (result.kind === 'paused') {
      try {
        await options.pausedHandler.handle({ result, reference, context })
      } catch {}
      return
    }
    try {
      await options.completionCoordinator.complete({
        envelope: result as FinalChatReplyEnvelope,
        present: async projection => await options.terminalPresenter.present({
          route: context.route,
          projection
        })
      })
    } catch {
      // The approval has already been consumed. Presentation failures cannot
      // make another plugin reuse the same decision message.
    }
  }
}

export function createYunzaiApprovalController (
  options: YunzaiApprovalControllerOptions
): YunzaiApprovalController {
  const outcomeHandler = options.outcomeHandler ?? createApprovalOutcomeHandler(options)
  return Object.freeze({
    async confirmToolOperation (event: YunzaiMessageEvent): Promise<boolean> {
      if (event.msg !== '确认' && event.msg !== '拒绝') return false
      const projection = await options.projector.project(event)
      if (projection === null) return false
      return await options.router.route(projection, outcomeHandler)
    }
  })
}
