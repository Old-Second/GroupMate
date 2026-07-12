import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { findProjectRoot } from '../helpers/project-root.js'

const projectRoot = findProjectRoot(import.meta.url)
const runtimePath = path.join(projectRoot, 'dist', 'runtime', 'browser-release.js')

async function loadRelease () {
  assert.equal(existsSync(runtimePath), true, 'compiled browser release module must exist')
  return await import(pathToFileURL(runtimePath).href)
}

test('owned Chromium is closed without triggering its disconnected listener', async () => {
  const { releaseBrowserAfterRender } = await loadRelease()
  const calls: string[] = []

  const result = await releaseBrowserAfterRender({
    browser: {
      removeAllListeners: (event: string) => calls.push(`remove:${event}`),
      process: () => {
        calls.push('process')
        return { pid: 1 }
      },
      close: async () => {
        calls.push('close')
      },
      disconnect: async () => {
        calls.push('disconnect')
      }
    },
    reportFailure: () => {
      calls.push('report')
    }
  })

  assert.equal(result, 'closed')
  assert.deepEqual(calls, ['remove:disconnected', 'process', 'close'])
})

test('shared Chromium is disconnected without closing the shared process', async () => {
  const { releaseBrowserAfterRender } = await loadRelease()
  const calls: string[] = []

  const result = await releaseBrowserAfterRender({
    browser: {
      removeAllListeners: (event: string) => calls.push(`remove:${event}`),
      process: () => {
        calls.push('process')
        return null
      },
      close: async () => {
        calls.push('close')
      },
      disconnect: async () => {
        calls.push('disconnect')
      }
    },
    reportFailure: () => {
      calls.push('report')
    }
  })

  assert.equal(result, 'disconnected')
  assert.deepEqual(calls, ['remove:disconnected', 'process', 'disconnect'])
})

test('legacy browser handles without process metadata are closed', async () => {
  const { releaseBrowserAfterRender } = await loadRelease()
  const calls: string[] = []

  const result = await releaseBrowserAfterRender({
    browser: {
      close: async () => {
        calls.push('close')
      }
    },
    reportFailure: () => {
      calls.push('report')
    }
  })

  assert.equal(result, 'closed')
  assert.deepEqual(calls, ['close'])
})

test('browser release failures are reported without replacing the rendered reply', async () => {
  const { releaseBrowserAfterRender } = await loadRelease()
  const fixtureError = Object.assign(new Error('private fixture'), {
    name: 'BrowserCloseError',
    code: 'close_failed'
  })
  const failures: unknown[] = []

  const result = await releaseBrowserAfterRender({
    browser: {
      process: () => ({ pid: 1 }),
      close: async () => {
        throw fixtureError
      }
    },
    reportFailure: (error: unknown) => failures.push(error)
  })

  assert.equal(result, 'failed')
  assert.deepEqual(failures, [fixtureError])
})

test('missing browser handles require no cleanup', async () => {
  const { releaseBrowserAfterRender } = await loadRelease()
  let failures = 0

  const result = await releaseBrowserAfterRender({
    browser: false,
    reportFailure: () => {
      failures++
    }
  })

  assert.equal(result, 'skipped')
  assert.equal(failures, 0)
})

test('browser release log exposes only the bounded release result', async () => {
  const { createBrowserReleaseLog } = await loadRelease()

  assert.deepEqual(createBrowserReleaseLog('closed'), {
    event: 'picture.browser.release',
    result: 'closed'
  })
  assert.deepEqual(createBrowserReleaseLog('private fixture'), {
    event: 'picture.browser.release',
    result: 'unknown'
  })
})
