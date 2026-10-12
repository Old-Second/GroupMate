import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRandomChoiceTool } from '../../src/tools/RandomChoiceTool.js'
import type { AuthorizedToolContext } from '../../src/agent/tools/tool-context.js'
import { ToolRegistry } from '../../src/agent/tools/tool-registry.js'

const context = { signal: new AbortController().signal } as AuthorizedToolContext
function payload (result: Awaited<ReturnType<ReturnType<typeof createRandomChoiceTool>['execute']>>): any {
  assert.equal(result.status, 'success')
  if (result.status !== 'success') assert.fail('expected a successful random choice')
  const text = result.content[0]
  assert.equal(text.type, 'text')
  return text.type === 'text' ? JSON.parse(text.text) : null
}

test('random choice picks without replacement and keeps the caller list unchanged', async () => {
  const items = ['面条', '米饭', '饺子', '披萨']
  const tool = createRandomChoiceTool(() => 0)
  new ToolRegistry([tool])
  const result = payload(await tool.execute({ items, mode: 'pick', count: 2 }, context))
  assert.deepEqual(result.selected, ['米饭', '饺子'])
  assert.deepEqual(items, ['面条', '米饭', '饺子', '披萨'])
  assert.equal(tool.retrySafe, false)
  assert.equal(tool.network, 'none')
})

test('random teams include every supplied label exactly once and differ in size by at most one', async () => {
  const items = ['A', 'B', 'C', 'D', 'E', 'F', 'G']
  const groups = payload(await createRandomChoiceTool().execute({ items, mode: 'teams', count: 3 }, context)).groups as string[][]
  assert.deepEqual(groups.flat().sort(), [...items].sort())
  assert.deepEqual(groups.map(group => group.length), [3, 2, 2])
})

test('ambiguous labels and invalid or excessive requests fail before randomness', async () => {
  const tool = createRandomChoiceTool(() => { throw new Error('must not sample') })
  for (const input of [
    { items: ['A', ' A '], mode: 'pick', count: 1 },
    { items: ['A'], mode: 'pick', count: 1 },
    { items: ['A', ''], mode: 'pick', count: 1 },
    { items: ['A', 'B'], mode: 'pick', count: 3 },
    { items: ['A', 'B'], mode: 'teams', count: 1 },
    { items: ['A', 'B'], mode: 'teams', count: 1.5 },
    { items: Array.from({ length: 51 }, (_, index) => String(index)), mode: 'pick', count: 1 }
  ]) assert.equal((await tool.execute(input, context)).status, 'denied')
})
