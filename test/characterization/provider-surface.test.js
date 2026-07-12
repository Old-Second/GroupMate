import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scanProviderSurface } from '../../scripts/audit-provider-surface.mjs'

test('legacy inventory finds every model provider scheduled for removal', async () => {
  const result = await scanProviderSurface(new URL('../../', import.meta.url))
  const byId = Object.fromEntries(result.map(item => [item.id, item.hits]))
  for (const id of ['chatgptWeb', 'bing', 'claude', 'gemini', 'qwen', 'chatglm', 'xinghuo', 'azureOpenai']) {
    assert.ok(byId[id].length > 0, `${id} must have baseline hits`)
  }
  assert.ok(byId.openaiCompatible.length > 0)
  assert.ok(result.every(item => item.hits.every(hit =>
    !hit.path.startsWith('server/static/') &&
    !hit.path.startsWith('docs/') &&
    !hit.path.startsWith('test/') &&
    hit.path !== 'AGENTS.md' &&
    hit.path !== 'NOTICE.md'
  )))
})
