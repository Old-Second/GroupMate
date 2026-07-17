import { spawnSync } from 'node:child_process'
import path from 'node:path'
import {
  auditPhase6SecurityBoundaries,
  type Phase6SecurityAuditResult
} from './phase-6-security-audit.js'

export const PHASE_6_VERIFICATION_CHECKS = Object.freeze([
  'build',
  'typecheck',
  'offline',
  'unit',
  'characterization',
  'resources',
  'security',
  'dist_reproducible'
] as const)

export type Phase6VerificationCheckName =
  typeof PHASE_6_VERIFICATION_CHECKS[number]

export interface Phase6VerificationCommand {
  readonly name: Exclude<Phase6VerificationCheckName, 'security'>
  readonly file: string
  readonly arguments: readonly string[]
}

export interface Phase6VerificationCheck {
  readonly name: Phase6VerificationCheckName
  readonly mandatory: boolean
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly code: 'ok' | 'command_failed' | 'not_authorized' | 'not_configured'
}

export interface Phase6VerificationResult {
  readonly checks: readonly Phase6VerificationCheck[]
  readonly passed: boolean
}

export interface Phase6VerificationOptions {
  readonly runCommand?: (command: Phase6VerificationCommand) => Promise<number>
  readonly securityAudit?: (
    projectRoot: string
  ) => Promise<Phase6SecurityAuditResult>
}

const COMMANDS: Readonly<Record<
Exclude<Phase6VerificationCheckName, 'security' | 'dist_reproducible'>,
Phase6VerificationCommand
>> = Object.freeze({
  build: command('build', 'pnpm', ['run', 'build']),
  typecheck: command('typecheck', 'pnpm', ['exec', 'tsc', '-p', 'tsconfig.test.json']),
  offline: command('offline', 'pnpm', ['test']),
  unit: command('unit', 'pnpm', ['run', 'test:unit']),
  characterization: command('characterization', 'pnpm', ['run', 'test:characterization']),
  resources: command('resources', process.execPath, ['scripts/measure-phase-6-resources.mjs'])
})

const DIST_BUILD_COMMAND = command('build', 'pnpm', ['run', 'build'])
const DIST_DIFF_COMMAND = command('dist_reproducible', 'git', [
  'diff',
  '--exit-code',
  '--',
  'dist'
])

function command (
  name: Phase6VerificationCommand['name'],
  file: string,
  arguments_: readonly string[]
): Phase6VerificationCommand {
  return Object.freeze({
    name,
    file,
    arguments: Object.freeze([...arguments_])
  })
}

function projectRoot (value: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('Phase 6 verification project root is invalid')
  }
  return path.resolve(value)
}

function result (
  name: Phase6VerificationCheckName,
  passed: boolean
): Phase6VerificationCheck {
  return Object.freeze({
    name,
    mandatory: true,
    status: passed ? 'passed' : 'failed',
    code: passed ? 'ok' : 'command_failed'
  })
}

function defaultRunner (root: string): (
  command: Phase6VerificationCommand
) => Promise<number> {
  return async input => {
    const child = spawnSync(input.file, input.arguments, {
      cwd: root,
      encoding: 'utf8',
      stdio: 'inherit'
    })
    if (child.error !== undefined || child.status === null) return 1
    return child.status
  }
}

export async function verifyPhase6 (
  value: string,
  options: Phase6VerificationOptions = {}
): Promise<Phase6VerificationResult> {
  const root = projectRoot(value)
  const runCommand = options.runCommand ?? defaultRunner(root)
  const securityAudit = options.securityAudit ?? auditPhase6SecurityBoundaries
  const checks: Phase6VerificationCheck[] = []

  for (const name of [
    'build',
    'typecheck',
    'offline',
    'unit',
    'characterization',
    'resources'
  ] as const) {
    checks.push(result(name, await runCommand(COMMANDS[name]) === 0))
  }

  const security = await securityAudit(root)
  checks.push(result('security', security.passed))

  const buildCode = await runCommand(DIST_BUILD_COMMAND)
  const diffCode = buildCode === 0
    ? await runCommand(DIST_DIFF_COMMAND)
    : 1
  checks.push(result('dist_reproducible', buildCode === 0 && diffCode === 0))

  const ordered = Object.freeze(PHASE_6_VERIFICATION_CHECKS.map(name => {
    const check = checks.find(current => current.name === name)
    if (check === undefined) throw new Error(`Phase 6 verification check missing: ${name}`)
    return check
  }))
  return Object.freeze({
    checks: ordered,
    passed: ordered.every(check => check.status === 'passed')
  })
}

export async function main (): Promise<void> {
  const verification = await verifyPhase6(process.cwd())
  process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`)
  if (!verification.passed) process.exitCode = 1
}
