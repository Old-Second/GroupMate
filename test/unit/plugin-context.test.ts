import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { findProjectRoot } from '../helpers/project-root.js'

const projectRoot = findProjectRoot(import.meta.url)
const runtimePath = path.join(projectRoot, 'dist/runtime/plugin-context.js')

test('compiled plugin context resolves the installed project identity', async () => {
  assert.equal(existsSync(runtimePath), true, 'compiled plugin context must exist')

  const context = await import(pathToFileURL(runtimePath).href)

  assert.equal(context.pluginRoot, projectRoot)
  assert.equal(context.pluginDirectoryName, path.basename(projectRoot))
  assert.equal(context.pluginId, 'groupmate')
  assert.equal(context.pluginDisplayName, 'GroupMate')
  assert.equal(context.repositoryUrl, 'https://github.com/Old-Second/GroupMate')
  assert.equal(
    context.resolvePluginPath('resources', 'help', 'index.html'),
    path.join(projectRoot, 'resources', 'help', 'index.html')
  )
})
