import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { scanProviderSurface } from '../../scripts/audit-provider-surface.mjs'

const execFileAsync = promisify(execFile)
const maxFileBytes = 524288
const maxTotalBytes = 8388608

test('provider inventory reports every category throughout removal', async () => {
  const result = await scanProviderSurface(new URL('../../', import.meta.url))
  const byId = Object.fromEntries(result.hits.map(item => [item.id, item.hits]))
  for (const id of ['chatgptWeb', 'bing', 'claude', 'gemini', 'qwen', 'chatglm', 'xinghuo', 'azureOpenai']) {
    assert.ok(Array.isArray(byId[id]), `${id} must remain an audited category`)
  }
  assert.ok(byId.openaiCompatible.length > 0)
  assert.ok(result.bytesRead > 0)
  assert.ok(result.bytesRead <= maxTotalBytes)
  assert.ok(result.hits.every(item => item.hits.every(hit =>
    !hit.path.startsWith('server/static/') &&
    !hit.path.startsWith('docs/') &&
    !hit.path.startsWith('test/') &&
    hit.path !== 'AGENTS.md' &&
    hit.path !== 'NOTICE.md'
  )))
})

test('removed provider categories reach exact zero', async () => {
  const result = await scanProviderSurface(new URL('../../', import.meta.url))
  const byId = Object.fromEntries(result.hits.map(item => [item.id, item.hits]))

  for (const id of ['chatgptWeb', 'bing', 'claude', 'gemini', 'qwen', 'chatglm', 'xinghuo', 'azureOpenai']) {
    assert.deepEqual(byId[id], [], `${id} must have no remaining surface`)
  }
  assert.ok(byId.openaiCompatible.length > 0)
})

test('provider inventory skips oversized tracked files before the read budget is consumed', async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'groupmate-provider-surface-'))
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }))

  await execFileAsync('git', ['init', '--quiet'], { cwd: fixtureRoot })
  await writeFile(path.join(fixtureRoot, '00-small.js'), "export const provider = 'claude'\n")
  const oversizedContent = `${'x'.repeat(maxFileBytes + 1)}\nclaude\n`
  await writeFile(path.join(fixtureRoot, '99-oversized.js'), oversizedContent)
  await execFileAsync('git', ['add', '00-small.js', '99-oversized.js'], { cwd: fixtureRoot })

  const result = await scanProviderSurface(pathToFileURL(`${fixtureRoot}${path.sep}`))

  assert.deepEqual(result.skipped, [{
    path: '99-oversized.js',
    reason: 'file-too-large',
    bytes: Buffer.byteLength(oversizedContent)
  }])
  assert.equal(result.bytesRead, Buffer.byteLength("export const provider = 'claude'\n"))
  assert.ok(result.bytesRead < maxFileBytes)
})

test('provider inventory never reads beyond a bounded total budget', async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'groupmate-provider-budget-'))
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }))

  await execFileAsync('git', ['init', '--quiet'], { cwd: fixtureRoot })
  const content = 'claude'.padEnd(40, 'x')
  for (const file of ['00-first.js', '01-second.js', '02-third.js']) {
    await writeFile(path.join(fixtureRoot, file), content)
  }
  await execFileAsync('git', ['add', '00-first.js', '01-second.js', '02-third.js'], { cwd: fixtureRoot })

  const result = await scanProviderSurface(
    pathToFileURL(`${fixtureRoot}${path.sep}`),
    { maxFileBytes: 64, maxTotalBytes: 64 }
  )

  assert.equal(result.bytesRead, 40)
  assert.deepEqual(result.skipped, [
    { path: '01-second.js', reason: 'total-budget-exceeded', bytes: 40 },
    { path: '02-third.js', reason: 'total-budget-exceeded', bytes: 40 }
  ])
})

test('provider inventory applies exact manifest fields only in their bounded scope', async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'groupmate-provider-field-'))
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }))

  await execFileAsync('git', ['init', '--quiet'], { cwd: fixtureRoot })
  await mkdir(path.join(fixtureRoot, 'utils'), { recursive: true })
  await writeFile(
    path.join(fixtureRoot, 'utils/config.js'),
    'export default { apiForceUseReverse: false }\n'
  )
  await execFileAsync('git', ['add', 'utils/config.js'], { cwd: fixtureRoot })

  const result = await scanProviderSurface(pathToFileURL(`${fixtureRoot}${path.sep}`))
  const chatgptWeb = result.hits.find(item => item.id === 'chatgptWeb')

  assert.deepEqual(chatgptWeb?.hits, [{ path: 'utils/config.js', line: 1 }])
})
