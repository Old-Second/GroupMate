export const CLOUD_TRANSCODE_TIMEOUT_MS = 10_000;
export async function withCloudTranscodeTimeout(operation, timeoutMs = CLOUD_TRANSCODE_TIMEOUT_MS) {
    const controller = new AbortController();
    let timeout;
    const timeoutPromise = new Promise((resolve, reject) => {
        timeout = setTimeout(() => {
            controller.abort();
            reject(controller.signal.reason);
        }, timeoutMs);
        timeout.unref();
    });
    try {
        return await Promise.race([
            operation(controller.signal),
            timeoutPromise
        ]);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
