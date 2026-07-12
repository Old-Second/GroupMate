import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { findProjectRoot } from '../helpers/project-root.js'

const projectRoot = findProjectRoot(import.meta.url)
const runtimePath = path.join(projectRoot, 'dist', 'runtime', 'picture-reply.js')

async function loadPresenter () {
  assert.equal(existsSync(runtimePath), true, 'compiled picture reply module must exist')
  return await import(pathToFileURL(runtimePath).href)
}

test('picture reply succeeds without text fallback', async () => {
  const { presentPictureReply } = await loadPresenter()
  const calls: string[] = []
  const result = await presentPictureReply({
    renderPicture: async () => {
      calls.push('render')
      return true
    },
    sendTextFallback: async () => {
      calls.push('fallback')
    },
    reportFailure: () => {
      calls.push('report')
    }
  })

  assert.equal(result, 'picture')
  assert.deepEqual(calls, ['render'])
})

test('picture reply reports one failure and falls back once', async () => {
  const { presentPictureReply } = await loadPresenter()
  const calls: string[] = []
  const result = await presentPictureReply({
    renderPicture: async () => {
      calls.push('render')
      throw new Error('private fixture')
    },
    sendTextFallback: async () => {
      calls.push('fallback')
    },
    reportFailure: () => {
      calls.push('report')
    }
  })

  assert.equal(result, 'text-fallback')
  assert.deepEqual(calls, ['render', 'report', 'fallback'])
})

test('empty picture result falls back without retrying', async () => {
  const { presentPictureReply } = await loadPresenter()
  let renders = 0
  let fallbacks = 0

  await presentPictureReply({
    renderPicture: async () => {
      renders++
      return false
    },
    sendTextFallback: async () => {
      fallbacks++
    },
    reportFailure: () => {}
  })

  assert.equal(renders, 1)
  assert.equal(fallbacks, 1)
})

test('picture renders are serialized and a failure does not poison the queue', async () => {
  const { presentPictureReply } = await loadPresenter()
  let active = 0
  let maxActive = 0
  let releaseFirst!: () => void
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve
  })
  const order: string[] = []

  const first = presentPictureReply({
    renderPicture: async () => {
      active++
      maxActive = Math.max(maxActive, active)
      order.push('first-start')
      await firstGate
      active--
      order.push('first-end')
      throw new Error('fixture failure')
    },
    sendTextFallback: async () => {
      order.push('first-fallback')
    },
    reportFailure: () => {}
  })
  const second = presentPictureReply({
    renderPicture: async () => {
      active++
      maxActive = Math.max(maxActive, active)
      order.push('second-start')
      active--
      return true
    },
    sendTextFallback: async () => {},
    reportFailure: () => {}
  })

  await Promise.resolve()
  releaseFirst()

  assert.deepEqual(await Promise.all([first, second]), ['text-fallback', 'picture'])
  assert.equal(maxActive, 1)
  assert.ok(order.indexOf('first-end') < order.indexOf('second-start'))
})
