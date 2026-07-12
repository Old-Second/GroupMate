type MaybePromise<T> = T | Promise<T>

interface BrowserHandle {
  process?: () => unknown
  close?: () => MaybePromise<void>
  disconnect?: () => MaybePromise<void>
  removeAllListeners?: (event: string) => unknown
}

interface BrowserReleaseOperations {
  browser?: BrowserHandle | false | null
  reportFailure: (error: unknown) => void
}

export type BrowserReleaseResult = 'closed' | 'disconnected' | 'failed' | 'skipped'

const browserReleaseResults = new Set<BrowserReleaseResult>([
  'closed',
  'disconnected',
  'failed',
  'skipped'
])

export function createBrowserReleaseLog (result: unknown) {
  return {
    event: 'picture.browser.release',
    result: typeof result === 'string' && browserReleaseResults.has(result as BrowserReleaseResult)
      ? result as BrowserReleaseResult
      : 'unknown'
  } as const
}

function createUnsupportedError () {
  return Object.assign(new Error('Browser handle cannot be released'), {
    name: 'BrowserReleaseUnsupportedError',
    code: 'unsupported_browser'
  })
}

export async function releaseBrowserAfterRender (
  operations: BrowserReleaseOperations
): Promise<BrowserReleaseResult> {
  const browser = operations.browser
  if (!browser) return 'skipped'

  try {
    browser.removeAllListeners?.('disconnected')

    const isSharedConnection = typeof browser.process === 'function' && browser.process() === null
    if (isSharedConnection && typeof browser.disconnect === 'function') {
      await browser.disconnect()
      return 'disconnected'
    }

    if (typeof browser.close === 'function') {
      await browser.close()
      return 'closed'
    }

    if (typeof browser.disconnect === 'function') {
      await browser.disconnect()
      return 'disconnected'
    }

    throw createUnsupportedError()
  } catch (error) {
    operations.reportFailure(error)
    return 'failed'
  }
}
