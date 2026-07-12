const browserReleaseResults = new Set([
    'closed',
    'disconnected',
    'failed',
    'skipped'
]);
export function createBrowserReleaseLog(result) {
    return {
        event: 'picture.browser.release',
        result: typeof result === 'string' && browserReleaseResults.has(result)
            ? result
            : 'unknown'
    };
}
function createUnsupportedError() {
    return Object.assign(new Error('Browser handle cannot be released'), {
        name: 'BrowserReleaseUnsupportedError',
        code: 'unsupported_browser'
    });
}
export async function releaseBrowserAfterRender(operations) {
    const browser = operations.browser;
    if (!browser)
        return 'skipped';
    try {
        browser.removeAllListeners?.('disconnected');
        const isSharedConnection = typeof browser.process === 'function' && browser.process() === null;
        if (isSharedConnection && typeof browser.disconnect === 'function') {
            await browser.disconnect();
            return 'disconnected';
        }
        if (typeof browser.close === 'function') {
            await browser.close();
            return 'closed';
        }
        if (typeof browser.disconnect === 'function') {
            await browser.disconnect();
            return 'disconnected';
        }
        throw createUnsupportedError();
    }
    catch (error) {
        operations.reportFailure(error);
        return 'failed';
    }
}
