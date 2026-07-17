import assert from 'node:assert/strict'
import { access, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const localImport = /(?:import\s+(?:[^'";]+?\s+from\s+)?|import\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g

async function exists (relative) {
  try {
    await access(path.join(root, relative))
    return true
  } catch {
    return false
  }
}

async function resolveLocal (from, specifier) {
  const candidate = path.normalize(path.join(path.dirname(from), specifier))
  for (const value of [candidate, `${candidate}.js`, path.join(candidate, 'index.js')]) {
    if (await exists(value)) return value
  }
  return null
}

async function productionFiles () {
  const appFiles = (await readdir(path.join(root, 'apps')))
    .filter(file => file.endsWith('.js'))
    .map(file => `apps/${file}`)
  const queue = ['index.js', ...appFiles]
  const files = new Set()
  while (queue.length > 0 && files.size < 1_024) {
    const file = queue.shift()
    if (files.has(file)) continue
    files.add(file)
    const source = await readFile(path.join(root, file), 'utf8')
    localImport.lastIndex = 0
    for (const match of source.matchAll(localImport)) {
      const resolved = await resolveLocal(file, match[2])
      if (resolved !== null && !files.has(resolved)) queue.push(resolved)
    }
  }
  return [...files]
}

test('production import graph has no legacy presenter or direct final reply path', async () => {
  assert.equal(await exists('model/legacy/reply-presenter.js'), false)
  assert.equal(await exists('test/characterization/legacy-reply-presenter.test.js'), false)

  const files = await productionFiles()
  assert.equal(files.length < 1_024, true)
  assert.deepEqual(files.filter(file => file.includes('model/legacy')), [])

  for (const file of [
    'apps/chat.js', 'apps/bym.js', 'apps/approval.js', 'apps/button.js',
    'src/runtime/yunzai-chat-controller.ts', 'src/runtime/yunzai-bym-controller.ts',
    'src/runtime/yunzai-approval-controller.ts', 'src/runtime/production-yunzai-agent.ts'
  ]) {
    const source = await readFile(path.join(root, file), 'utf8')
    assert.doesNotMatch(source, /presentLegacyReply|cacheContent|renderImage|replyWithoutRecallingUserMessage/)
    if (file.startsWith('apps/')) assert.doesNotMatch(source, /\bevent\.reply\s*\(/)
  }
  const bym = await readFile(path.join(root, 'src/runtime/yunzai-bym-controller.ts'), 'utf8')
  assert.doesNotMatch(bym, /customSplitRegex/)
  const shells = await Promise.all([
    'apps/chat.js', 'apps/bym.js', 'apps/approval.js'
  ].map(file => readFile(path.join(root, file), 'utf8')))
  assert.doesNotMatch(shells.join('\n'), /utils\/(?:common|tts)|runtime\/presentation|generateAudio/)
})
