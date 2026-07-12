import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const root = process.cwd()

test('package keeps only dependencies used by the supported provider path', async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(root, 'package.json'), 'utf8')
  ) as {
    dependencies: Record<string, string>
    optionalDependencies: Record<string, string>
    pnpm?: { patchedDependencies?: Record<string, string> }
  }
  const allRuntime = {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies
  }

  for (const dependency of [
    '@azure/openai',
    '@google/generative-ai',
    'cycletls',
    'openai',
    'asn1.js',
    'eventsource'
  ]) {
    assert.equal(Object.hasOwn(allRuntime, dependency), false, `${dependency} must be removed`)
  }
  for (const dependency of ['quick-lru', 'eventsource-parser']) {
    assert.equal(Object.hasOwn(allRuntime, dependency), true, `${dependency} must remain`)
  }
  assert.deepEqual(packageJson.pnpm?.patchedDependencies ?? {}, {})
})

test('the removed provider patch is deleted', async () => {
  let error: NodeJS.ErrnoException | undefined
  try {
    await access(path.join(root, 'patches/@google__generative-ai@0.1.1.patch'))
  } catch (caught) {
    error = caught as NodeJS.ErrnoException
  }
  assert.equal(error?.code, 'ENOENT')
})
