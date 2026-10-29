import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  decodeValue,
  encodeValue
} from '../../dist/verification/host-bootstrap-baseline.js'
import {
  configuredReasoningEffort,
  configuredThinkingMode,
  finiteInteger,
  finiteNumber,
  normalizedStringList,
  normalizedText
} from '../../dist/runtime/host/host-config-values.js'
import {
  parsePreferenceRecord,
  projectBymPolicySnapshot,
  projectButtonPolicySnapshot,
  projectChatPreferences,
  projectDefaultPreferences,
  projectPresentationSafeConfig,
  resolveTtsMode
} from '../../dist/runtime/host/host-config-projection.js'

// Regenerate with `node scripts/capture-host-bootstrap-baseline.mjs`; both values are pinned here
// so a regenerated fixture cannot quietly move the baseline it claims to reproduce.
const BASELINE_COMMIT = 'a8d6279654dacb8d83b6555edd74f1035be2cd65'
const BASELINE_SHA256 = '3d295282ce593c0d5541a789d080753a263d6828b6dfae695c7bb378605ca985'

const CALLERS = Object.freeze({
  normalizedText: (args) => normalizedText(args[0], args[1], args[2]),
  normalizedStringList: (args) => normalizedStringList(args[0], args[1], args[2]),
  finiteInteger: (args) => finiteInteger(args[0], args[1], args[2], args[3]),
  finiteNumber: (args) => finiteNumber(args[0], args[1], args[2], args[3]),
  configuredThinkingMode: (args) => configuredThinkingMode(args[0]),
  configuredReasoningEffort: (args) => configuredReasoningEffort(args[0]),
  parsePreferenceRecord: (args) => parsePreferenceRecord(args[0]),
  ttsMode: (_args, config) => resolveTtsMode(config),
  currentPresentationConfig: (_args, config) => projectPresentationSafeConfig(config),
  defaultPreferences: (_args, config) => projectDefaultPreferences(config),
  projectPreferences: (args, config) => projectChatPreferences(args[0] ?? {}, config),
  'buttonPolicy.snapshot': (_args, config) => projectButtonPolicySnapshot(config),
  'bymPolicy.snapshot': (_args, config) => projectBymPolicySnapshot(config)
})

async function fixture () {
  const url = new URL(
    '../fixtures/host-bootstrap/batch-1-config-projection.json',
    import.meta.url
  )
  return JSON.parse(await readFile(url, 'utf8'))
}

test('the captured baseline still describes the pre-migration entry point', async () => {
  const baseline = await fixture()
  assert.equal(baseline.schemaVersion, 1)
  assert.equal(baseline.baselineCommit, BASELINE_COMMIT)
  assert.equal(baseline.baselineSha256, BASELINE_SHA256)
  assert.equal(baseline.generator, 'src/verification/host-bootstrap-baseline.ts')

  // Fixture rows the replay cannot dispatch would otherwise pass as a vacuous check.
  assert.deepEqual(
    [...new Set(baseline.rows.map(row => row.fn))].sort(),
    Object.keys(CALLERS).sort()
  )
  for (const row of baseline.rows) {
    assert.equal(
      row.config === null || Object.hasOwn(baseline.configFixtures, row.config),
      true,
      `row for ${row.fn} names an unknown config fixture`
    )
  }
  assert.deepEqual(
    Object.keys(baseline.configFixtures).sort(),
    ['boundaryHigh', 'boundaryLow', 'configured', 'empty', 'unicode', 'wrongTypes']
  )
  assert.equal(baseline.rows.length, 169)
})

test('typed host config projection reproduces every captured legacy row', async () => {
  const baseline = await fixture()
  const configs = new Map(
    Object.entries(baseline.configFixtures).map(([name, value]) => [name, decodeValue(value)])
  )
  const divergences = []
  for (const [index, row] of baseline.rows.entries()) {
    const args = row.args.map(decodeValue)
    const config = row.config === null ? configs.get('empty') : configs.get(row.config)
    const actual = CALLERS[row.fn](args, config)
    const encoded = encodeValue(actual)
    const frozen = actual !== null && typeof actual === 'object' ? Object.isFrozen(actual) : null
    if (JSON.stringify(encoded) !== JSON.stringify(row.result) || frozen !== row.frozen) {
      divergences.push({ index, fn: row.fn, config: row.config, expected: row.result, actual: encoded, expectedFrozen: row.frozen, actualFrozen: frozen })
    }
  }
  assert.deepEqual(divergences, [])
})

test('the migrated helpers have exactly one editable copy', async () => {
  const index = await readFile(new URL('../../index.js', import.meta.url), 'utf8')
  for (const name of [
    'normalizedText', 'normalizedStringList', 'finiteInteger', 'finiteNumber',
    'configuredThinkingMode', 'configuredReasoningEffort', 'ttsMode',
    'currentPresentationConfig', 'defaultPreferences', 'parsePreferenceRecord',
    'projectPreferences'
  ]) {
    assert.equal(
      index.includes(`\nfunction ${name} (`),
      false,
      `${name} still has a legacy definition in index.js`
    )
  }
  assert.match(index, /from '\.\/dist\/runtime\/host\/host-config-values\.js'/)
  assert.match(index, /from '\.\/dist\/runtime\/host\/host-config-projection\.js'/)
})
