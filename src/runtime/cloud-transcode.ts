export const CLOUD_TRANSCODE_TIMEOUT_MS = 10_000

export async function withCloudTranscodeTimeout<T> (
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs = CLOUD_TRANSCODE_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController()
  let timeout: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<never>((resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(controller.signal.reason)
    }, timeoutMs)
    timeout.unref()
  })

  try {
    return await Promise.race([
      operation(controller.signal),
      timeoutPromise
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
