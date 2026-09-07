/**
 * Whether a rejected image-carrying request is worth one context-free retry.
 *
 * Host image links carry a signature that expires within the hour, so a replayed
 * image makes the provider refuse the whole request as malformed and the member
 * only sees an unhelpable error. Dropping the optional context also drops the
 * replayed image, which turns that dead end into a plain answer.
 */
export function expiredImageInputRecoveryHint(error) {
    return error.requestImageInputs && error.code === 'provider_invalid_request' &&
        error.stage === 'model.response' && error.statusCode === 400
        ? 'drop_optional_context_once'
        : 'none';
}
