import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const pluginId = 'groupmate'
export const pluginDisplayName = 'GroupMate'
export const repositoryUrl = 'https://github.com/Old-Second/GroupMate'

function findPluginRoot (metaUrl: string): string {
  let current = path.dirname(fileURLToPath(metaUrl))

  while (true) {
    const packagePath = path.join(current, 'package.json')
    if (existsSync(packagePath)) {
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
      if (packageJson.name === pluginId) return current
    }

    const parent = path.dirname(current)
    if (parent === current) {
      throw new Error(`${pluginDisplayName} plugin root not found`)
    }
    current = parent
  }
}

export const pluginRoot = findPluginRoot(import.meta.url)
export const pluginDirectoryName = path.basename(pluginRoot)

export function resolvePluginPath (...segments: string[]): string {
  return path.join(pluginRoot, ...segments)
}
