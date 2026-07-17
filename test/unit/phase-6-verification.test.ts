import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  PHASE_6_VERIFICATION_CHECKS,
  verifyPhase6,
  type Phase6VerificationCheckName,
  type Phase6VerificationCommand
} from '../../src/verification/phase-6-verification.js'

const root = process.cwd()

const safeAudit = Object.freeze({
  forbiddenFields: Object.freeze([]),
  unsafeLoggerCalls: Object.freeze([]),
  forbiddenTraceRedisCommands: Object.freeze([]),
  dynamicMetricDefinitions: Object.freeze([]),
  sourceDistMismatches: Object.freeze([]),
  forbiddenProductionEdges: Object.freeze([]),
  passed: true
})

test('verification runs all eight mandatory checks with fixed commands', async () => {
  const commands: Phase6VerificationCommand[] = []
  const result = await verifyPhase6(root, {
    runCommand: async command => {
      commands.push(command)
      return 0
    },
    securityAudit: async () => safeAudit
  })

  assert.deepEqual(PHASE_6_VERIFICATION_CHECKS, [
    'build', 'typecheck', 'offline', 'unit', 'characterization',
    'resources', 'security', 'dist_reproducible'
  ])
  assert.deepEqual(result.checks, PHASE_6_VERIFICATION_CHECKS.map(name => ({
    name,
    mandatory: true,
    status: 'passed',
    code: 'ok'
  })))
  assert.equal(result.passed, true)
  assert.deepEqual(commands.map(command => [command.file, ...command.arguments]), [
    ['pnpm', 'run', 'build'],
    ['pnpm', 'exec', 'tsc', '-p', 'tsconfig.test.json'],
    ['pnpm', 'test'],
    ['pnpm', 'run', 'test:unit'],
    ['pnpm', 'run', 'test:characterization'],
    [process.execPath, 'scripts/measure-phase-6-resources.mjs'],
    ['pnpm', 'run', 'build'],
    ['git', 'diff', '--exit-code', '--', 'dist']
  ])
})

test('one command or security failure fails only its check and the aggregate', async () => {
  for (const failedName of PHASE_6_VERIFICATION_CHECKS) {
    let buildCount = 0
    const result = await verifyPhase6(root, {
      runCommand: async command => {
        const name = command.name
        if (name === 'build') buildCount += 1
        const effectiveName: Phase6VerificationCheckName =
          name === 'build' && buildCount === 2 ? 'dist_reproducible' : name
        return effectiveName === failedName ? 1 : 0
      },
      securityAudit: async () => failedName === 'security'
        ? Object.freeze({ ...safeAudit, forbiddenFields: Object.freeze(['fixture:text']), passed: false })
        : safeAudit
    })
    assert.equal(result.passed, false, failedName)
    const failed = result.checks.filter(check => check.status === 'failed')
    assert.deepEqual(failed.map(check => check.name), [failedName])
    assert.equal(failed[0]?.code, 'command_failed')
  }
})

test('Phase 6 verification script is a static one-import one-main shell', async () => {
  const source = await readFile(path.join(root, 'scripts/verify-phase-6.mjs'), 'utf8')
  assert.match(source, /^import \{ main \} from '\.\.\/dist\/verification\/phase-6-verification\.js';?\nawait main\(\);?\n?$/)
  assert.doesNotMatch(source.split('\n').slice(1).join('\n'), /process\.|if\s*\(|spawn|pnpm|git|security/i)
})

test('package exposes the exact Phase 6 verification command', async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  assert.equal(
    packageJson.scripts['verify:phase6'],
    'pnpm run build && node scripts/verify-phase-6.mjs'
  )
})
