import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  PENDING_INDICATOR_REDIS_KEY,
  createPendingIndicatorConfigPort
} from '../../dist/runtime/presentation/pending-indicator-config.js'

const root = process.cwd()

test('Guoba and management commands share CHATGPT CONFIRM compatibility', async () => {
  const values = new Map()
  const port = createPendingIndicatorConfigPort({
    get: async key => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value)
      return 'OK'
    }
  })

  assert.equal(PENDING_INDICATOR_REDIS_KEY, 'CHATGPT:CONFIRM')
  assert.equal(await port.getEnabled(), true)
  await port.setEnabled(false)
  assert.equal(values.get(PENDING_INDICATOR_REDIS_KEY), 'off')
  await port.setEnabled(true)
  assert.equal(values.get(PENDING_INDICATOR_REDIS_KEY), 'on')

  const sources = await Promise.all([
    'src/runtime/presentation/pending-indicator-config.ts',
    'guoba.support.js',
    'apps/chat.js',
    'apps/management.js',
    'server/index.js'
  ].map(async file => [file, await readFile(path.join(root, file), 'utf8')]))
  const owners = sources.filter(([, source]) => source.includes('CHATGPT:CONFIRM'))
  assert.deepEqual(owners.map(([file]) => file), [
    'src/runtime/presentation/pending-indicator-config.ts'
  ])

  const management = sources.find(([file]) => file === 'apps/management.js')?.[1] ?? ''
  assert.match(management, /已开启显示正在思考提示/)
  assert.match(management, /已关闭显示正在思考提示/)
  assert.match(management, /createPendingIndicatorConfigPort/)
  assert.match(sources.find(([file]) => file === 'guoba.support.js')?.[1] ?? '', /turnConfirm/)
  assert.match(sources.find(([file]) => file === 'server\/index.js')?.[1] ?? '', /turnConfirm/)
})
