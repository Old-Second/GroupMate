import { deliverWithDefiniteRetry } from './presentation/yunzai-outbound-port.js';
import { plainTextPart } from './presentation/text-presentation.js';
import { APPROVAL_RECOVERY_DEFERRED_MESSAGE } from './run-approval-router.js';
export function createApprovalControlPresenter(input) {
    return Object.freeze({
        async presentRecoveryDeferred({ approvalAddress, signal }) {
            const outbound = await input.outboundFactory.forTarget(approvalAddress);
            return await deliverWithDefiniteRetry(outbound, plainTextPart(APPROVAL_RECOVERY_DEFERRED_MESSAGE), signal === undefined ? undefined : { signal });
        }
    });
}
export function createApprovalOutcomeHandler(options) {
    return async (result, reference, context) => {
        if (result.kind === 'approval_deferred') {
            try {
                await options.controlPresenter.presentRecoveryDeferred({
                    approvalAddress: reference.approvalAddress
                });
            }
            catch { }
            return;
        }
        if (result.kind === 'paused') {
            try {
                await options.pausedHandler.handle({ result, reference, context });
            }
            catch { }
            return;
        }
        try {
            await options.completionCoordinator.complete({
                envelope: result,
                present: async (projection) => await options.terminalPresenter.present({
                    route: context.route,
                    projection
                })
            });
        }
        catch {
            // The approval has already been consumed. Presentation failures cannot
            // make another plugin reuse the same decision message.
        }
    };
}
export function createYunzaiApprovalController(options) {
    const outcomeHandler = options.outcomeHandler ?? createApprovalOutcomeHandler(options);
    return Object.freeze({
        async confirmToolOperation(event) {
            if (event.msg !== '确认' && event.msg !== '拒绝')
                return false;
            const projection = await options.projector.project(event);
            if (projection === null)
                return false;
            return await options.router.route(projection, outcomeHandler);
        }
    });
}
