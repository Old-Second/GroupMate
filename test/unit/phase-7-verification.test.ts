import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  PHASE_7_VERIFICATION_CHECKS,
  phase7DistJavaScriptHash,
  verifyPhase7,
  type Phase7VerificationCheckName,
  type Phase7VerificationCommand
} from '../../src/verification/phase-7-verification.js'

const root = process.cwd()

const safeAudit = Object.freeze({
  forbiddenFields: Object.freeze([]),
  unsafeLoggerCalls: Object.freeze([]),
  forbiddenTraceRedisCommands: Object.freeze([]),
  dynamicMetricDefinitions: Object.freeze([]),
  sourceDistMismatches: Object.freeze([]),
  forbiddenProductionEdges: Object.freeze([]),
  forbiddenRedactedBodyFields: Object.freeze([]),
  forbiddenProviderIsolationLeaks: Object.freeze([]),
  forbiddenContextArtifactLeaks: Object.freeze([]),
  invalidContentJournalBoundaries: Object.freeze([]),
  forbiddenPhase7Edges: Object.freeze([]),
  passed: true
})

test('verification runs all eight mandatory checks with fixed commands', async () => {
  const commands: Phase7VerificationCommand[] = []
  const result = await verifyPhase7(root, {
    runCommand: async command => {
      commands.push(command)
      return 0
    },
    securityAudit: async () => safeAudit,
    distJavaScriptHash: async () => 'same'
  })

  assert.deepEqual(PHASE_7_VERIFICATION_CHECKS, [
    'build', 'typecheck', 'offline', 'unit', 'characterization',
    'resources', 'security', 'dist_reproducible'
  ])
  assert.deepEqual(result.checks, PHASE_7_VERIFICATION_CHECKS.map(name => ({
    name,
    mandatory: true,
    status: 'passed',
    code: 'ok'
  })))
  assert.equal(result.passed, true)
  assert.deepEqual(commands.map(command => [command.name, command.file, ...command.arguments]), [
    ['build', 'pnpm', 'run', 'build'],
    ['typecheck', 'pnpm', 'exec', 'tsc', '-p', 'tsconfig.test.json'],
    ['offline', 'pnpm', 'test'],
    ['unit', 'pnpm', 'run', 'test:unit'],
    ['characterization', 'pnpm', 'run', 'test:characterization'],
    ['resources', process.execPath, 'scripts/measure-phase-7-resources.mjs'],
    ['dist_reproducible', 'pnpm', 'run', 'build']
  ])
})

test('one command, security, or dist hash mismatch fails only its check and the aggregate', async () => {
  for (const failedName of PHASE_7_VERIFICATION_CHECKS) {
    let hashCount = 0
    const result = await verifyPhase7(root, {
      runCommand: async command =>
        failedName !== 'dist_reproducible' && command.name === failedName ? 1 : 0,
      securityAudit: async () => failedName === 'security'
        ? Object.freeze({
            ...safeAudit,
            forbiddenProviderIsolationLeaks: Object.freeze(['fixture:user_id']),
            passed: false
          })
        : safeAudit,
      distJavaScriptHash: async () => {
        hashCount += 1
        return failedName === 'dist_reproducible' && hashCount === 2 ? 'changed' : 'same'
      }
    })
    assert.equal(result.passed, false, failedName)
    const failed = result.checks.filter(check => check.status === 'failed')
    assert.deepEqual(failed.map(check => check.name), [failedName])
    assert.equal(failed[0]?.code, 'command_failed')
  }
})

test('dist reproducibility hashes bounded sorted JavaScript paths and contents', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'groupmate-phase7-dist-'))
  try {
    await mkdir(path.join(temporary, 'dist', 'nested'), { recursive: true })
    await writeFile(path.join(temporary, 'dist', 'z.js'), 'export const z = 1\n')
    await writeFile(path.join(temporary, 'dist', 'nested', 'a.js'), 'export const a = 1\n')
    await writeFile(path.join(temporary, 'dist', 'ignored.map'), 'not hashed\n')

    const first = await phase7DistJavaScriptHash(temporary)
    await rm(path.join(temporary, 'dist'), { recursive: true, force: true })
    await mkdir(path.join(temporary, 'dist', 'nested'), { recursive: true })
    await writeFile(path.join(temporary, 'dist', 'nested', 'a.js'), 'export const a = 1\n')
    await writeFile(path.join(temporary, 'dist', 'z.js'), 'export const z = 1\n')
    const reordered = await phase7DistJavaScriptHash(temporary)
    assert.equal(reordered, first)

    await writeFile(path.join(temporary, 'dist', 'z.js'), 'export const z = 2\n')
    assert.notEqual(await phase7DistJavaScriptHash(temporary), first)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test('Phase 7 verification script is a static one-import one-main shell', async () => {
  const source = await readFile(path.join(root, 'scripts/verify-phase-7.mjs'), 'utf8')
  assert.match(source, /^import \{ main \} from '\.\.\/dist\/verification\/phase-7-verification\.js';?\nawait main\(\);?\n?$/)
  assert.doesNotMatch(source.split('\n').slice(1).join('\n'), /process\.|if\s*\(|spawn|pnpm|git|security/i)
})

test('package exposes the exact Phase 7 resource and unified verification commands', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  assert.equal(
    packageJson.scripts['test:resources:phase7'],
    'pnpm run build && node scripts/measure-phase-7-resources.mjs'
  )
  assert.equal(
    packageJson.scripts['verify:phase7'],
    'pnpm run build && node scripts/verify-phase-7.mjs'
  )
})

test('dist hash failure is fail closed and does not affect earlier checks', async () => {
  const result = await verifyPhase7(root, {
    runCommand: async () => 0,
    securityAudit: async () => safeAudit,
    distJavaScriptHash: async () => { throw new Error('fixture') }
  })
  const byName = new Map<Phase7VerificationCheckName, string>(
    result.checks.map(check => [check.name, check.status])
  )
  assert.equal(byName.get('dist_reproducible'), 'failed')
  assert.ok(PHASE_7_VERIFICATION_CHECKS
    .filter(name => name !== 'dist_reproducible')
    .every(name => byName.get(name) === 'passed'))
  assert.equal(result.passed, false)
})

test('command exceptions fail one check closed while later checks still run', async () => {
  const commands: string[] = []
  const result = await verifyPhase7(root, {
    runCommand: async command => {
      commands.push(command.name)
      if (command.name === 'typecheck') throw new Error('fixture')
      return 0
    },
    securityAudit: async () => safeAudit,
    distJavaScriptHash: async () => 'same'
  })

  assert.deepEqual(result.checks.filter(check => check.status === 'failed').map(check => check.name), [
    'typecheck'
  ])
  assert.deepEqual(commands, [
    'build', 'typecheck', 'offline', 'unit', 'characterization', 'resources',
    'dist_reproducible'
  ])
  assert.equal(result.passed, false)
})
