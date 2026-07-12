import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export function findProjectRoot (metaUrl: string): string {
  let current = path.dirname(fileURLToPath(metaUrl))

  while (true) {
    const packagePath = path.join(current, 'package.json')
    if (existsSync(packagePath)) {
      const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'))
      if (packageJson.name === 'groupmate') return current
    }

    const parent = path.dirname(current)
    if (parent === current) throw new Error('GroupMate project root not found')
    current = parent
  }
}
