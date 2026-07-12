import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { findProjectRoot } from '../helpers/project-root.js'

const projectRoot = findProjectRoot(import.meta.url)
const runtimeRoots = ['apps', 'client', 'model', 'server', 'utils']

async function collectRuntimeSources (directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const sources: string[] = []

  for (const entry of entries) {
    if (entry.name === 'static') continue
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      sources.push(...await collectRuntimeSources(entryPath))
    } else if (/\.[cm]?[jt]s$/.test(entry.name)) {
      sources.push(entryPath)
    }
  }

  return sources
}

test('runtime sources do not depend on the legacy plugin directory', async () => {
  const sources = [
    path.join(projectRoot, 'index.js'),
    path.join(projectRoot, 'guoba.support.js')
  ]

  for (const root of runtimeRoots) {
    sources.push(...await collectRuntimeSources(path.join(projectRoot, root)))
  }

  const offenders: string[] = []
  for (const source of sources) {
    const content = await readFile(source, 'utf8')
    if (content.includes('plugins/chatgpt-plugin')) {
      offenders.push(path.relative(projectRoot, source))
    }
  }

  assert.deepEqual(offenders, [])
})

test('Guoba registers GroupMate as an independent plugin', async () => {
  const source = await readFile(path.join(projectRoot, 'guoba.support.js'), 'utf8')

  assert.match(
    source,
    /import\s*\{[^}]*pluginId[^}]*repositoryUrl[^}]*\}\s*from\s*['"]\.\/dist\/runtime\/plugin-context\.js['"]/
  )
  assert.match(source, /name:\s*pluginId/)
  assert.match(source, /title:\s*'GroupMate'/)
  assert.match(source, /author:\s*'Old-Second'/)
  assert.match(source, /link:\s*repositoryUrl/)
})

test('installation documentation uses the independent GroupMate directory', async () => {
  const readme = await readFile(path.join(projectRoot, 'README.md'), 'utf8')

  assert.match(readme, /plugins\/GroupMate/)
  assert.doesNotMatch(readme, /plugins\/chatgpt-plugin/)
})
