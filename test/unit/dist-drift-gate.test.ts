import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkDistDrift } from '../../src/verification/dist-drift-gate.js'

function runner (
  responses: Readonly<Record<string, { status: number | null; stdout: string }>>
): (args: readonly string[]) => { status: number | null; stdout: string } {
  return args => responses[args[0] ?? ''] ?? { status: 1, stdout: '' }
}

const tracked = { status: 0, stdout: 'dist/index.js\ndist/runtime/agent-service.js\n' }

test('a clean dist tree passes the gate', () => {
  assert.deepEqual(checkDistDrift({
    runGit: runner({ 'ls-files': tracked, status: { status: 0, stdout: '' } })
  }), { passed: true, reason: 'clean', paths: [], truncated: 0 })
})

test('modified, deleted and untracked dist output all fail the gate', () => {
  const result = checkDistDrift({
    runGit: runner({
      'ls-files': tracked,
      status: {
        status: 0,
        stdout: ' M dist/agent/tools/tool-executor.js\n D dist/runtime/old.js\n?? dist/runtime/new.js\n'
      }
    })
  })

  assert.equal(result.passed, false)
  assert.equal(result.reason, 'drifted')
  assert.deepEqual(result.paths, [
    'M dist/agent/tools/tool-executor.js',
    'D dist/runtime/old.js',
    '?? dist/runtime/new.js'
  ])
  assert.equal(result.truncated, 0)
})

test('a large drift is reported with a bounded path list', () => {
  const stdout = Array.from({ length: 64 }, (_value, index) => ` M dist/file-${index}.js`).join('\n')
  const result = checkDistDrift({ runGit: runner({ 'ls-files': tracked, status: { status: 0, stdout } }) })

  assert.equal(result.passed, false)
  assert.equal(result.paths.length, 50)
  assert.equal(result.truncated, 14)
})

test('an untracked or unreadable dist tree fails instead of passing silently', () => {
  for (const responses of [
    { 'ls-files': { status: 0, stdout: '' }, status: { status: 0, stdout: '' } },
    { 'ls-files': { status: 128, stdout: '' }, status: { status: 0, stdout: '' } },
    { 'ls-files': { status: null, stdout: '' }, status: { status: 0, stdout: '' } },
    { 'ls-files': tracked, status: { status: 128, stdout: '' } }
  ]) {
    const result = checkDistDrift({ runGit: runner(responses) })
    assert.equal(result.passed, false, JSON.stringify(responses))
    assert.equal(result.reason, 'git_unavailable', JSON.stringify(responses))
  }
})
