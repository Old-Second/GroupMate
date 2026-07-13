import { readChatErrorMetadata } from './chat-error-presentation.js';
export async function withInvalidFormatRecovery(options) {
    try {
        return await options.attempt('primary');
    }
    catch (error) {
        if (!options.canRecover || readChatErrorMetadata(error).statusCode !== 400) {
            throw error;
        }
        options.onRecovery?.();
        return await options.attempt('recovery');
    }
}
