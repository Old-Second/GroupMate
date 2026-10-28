import { spawnSync } from 'node:child_process'

/**
 * Committed `dist/` drift gate.
 *
 * The memory-constrained deployment host consumes the committed `dist/` output
 * instead of building, so a source change that is not rebuilt and committed
 * silently ships stale runtime code. `pnpm test` rebuilds `dist/` first, so a
 * clean working tree afterwards proves the committed output matches `src/`.
 *
 * The gate only reads Git state: it never rebuilds, writes or reverts anything.
 */

const MAX_REPORTED_PATHS = 50

export interface DistDriftGateResult {
  readonly passed: boolean
  readonly reason: 'clean' | 'drifted' | 'git_unavailable'
  readonly paths: readonly string[]
  readonly truncated: number
}

export interface DistDriftGateOptions {
  readonly cwd?: string
  readonly runGit?: (args: readonly string[]) => { status: number | null; stdout: string }
}

function defaultRunner (cwd: string): (args: readonly string[]) => {
  status: number | null
  stdout: string
} {
  return args => {
    const child = spawnSync('git', [...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024
    })
    return {
      status: child.error === undefined ? child.status : null,
      stdout: typeof child.stdout === 'string' ? child.stdout : ''
    }
  }
}

export function checkDistDrift (options: DistDriftGateOptions = {}): DistDriftGateResult {
  const runGit = options.runGit ?? defaultRunner(options.cwd ?? process.cwd())
  const tracked = runGit(['ls-files', '--', 'dist'])
  if (tracked.status !== 0 || tracked.stdout.trim() === '') {
    return Object.freeze({
      passed: false, reason: 'git_unavailable', paths: Object.freeze([]), truncated: 0
    })
  }
  const status = runGit(['status', '--porcelain', '--untracked-files=all', '--', 'dist'])
  if (status.status !== 0) {
    return Object.freeze({
      passed: false, reason: 'git_unavailable', paths: Object.freeze([]), truncated: 0
    })
  }
  const lines = status.stdout.split('\n').map(line => line.trim()).filter(line => line !== '')
  if (lines.length === 0) {
    return Object.freeze({ passed: true, reason: 'clean', paths: Object.freeze([]), truncated: 0 })
  }
  return Object.freeze({
    passed: false,
    reason: 'drifted',
    paths: Object.freeze(lines.slice(0, MAX_REPORTED_PATHS)),
    truncated: Math.max(0, lines.length - MAX_REPORTED_PATHS)
  })
}

export async function main (): Promise<void> {
  const result = checkDistDrift()
  if (result.passed) {
    process.stdout.write('committed dist/ matches the built output\n')
    return
  }
  if (result.reason === 'git_unavailable') {
    process.stderr.write('dist drift gate could not read the tracked dist/ output through git\n')
    process.exitCode = 1
    return
  }
  process.stderr.write(
    'committed dist/ drifted from the built output; run `pnpm run build` and commit dist/:\n'
  )
  for (const path of result.paths) process.stderr.write(`  ${path}\n`)
  if (result.truncated > 0) {
    process.stderr.write(`  ... and ${result.truncated} more path(s)\n`)
  }
  process.exitCode = 1
}
