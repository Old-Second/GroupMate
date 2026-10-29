import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  ATOMS,
  BOTS,
  BUTTON_POLICIES,
  FLOWS,
  PARTS,
  RESOURCES,
  SEGMENTS,
  TARGETS,
  botPickerFor,
  buildRowsWith,
  buttonPolicyPort,
  hostSegment
} from '../../dist/verification/host-outbound-baseline.js'
import { createHostOutbound } from '../../dist/runtime/host/host-outbound.js'

// Regenerate with `node scripts/capture-host-outbound-baseline.mjs`; both values are pinned here so
// a regenerated fixture cannot quietly move the baseline it claims to reproduce.
const BASELINE_COMMIT = '5bf84e2c05f43c118f28ca0d21480a0474708203'
const BASELINE_SHA256 = '5a7287db38ca41e301e9955fb1e4967ba393de9b978ddece79028eb48b77af80'

async function fixture () {
  const url = new URL('../fixtures/host-bootstrap/batch-3-outbound.json', import.meta.url)
  return JSON.parse(await readFile(url, 'utf8'))
}

function typedRows () {
  return buildRowsWith((scenario, log) => {
    const segment = hostSegment(SEGMENTS[scenario.segment], log)
    return createHostOutbound({
      segment: () => segment,
      botPicker: botPickerFor(scenario.bot, log),
      buttonPolicy: buttonPolicyPort(scenario.buttonPolicy)
    })
  })
}

test('the captured outbound baseline still describes the pre-migration entry point', async () => {
  const baseline = await fixture()
  assert.equal(baseline.schemaVersion, 1)
  assert.equal(baseline.baselineCommit, BASELINE_COMMIT)
  assert.equal(baseline.baselineSha256, BASELINE_SHA256)
  assert.equal(baseline.generator, 'src/verification/host-outbound-baseline.ts')
  assert.deepEqual(
    [...new Set(baseline.rows.map(row => row.fn))].sort(),
    [
      'flow', 'outboundMessage', 'outboundMessageWithoutForwardSupport',
      'resourceValue', 'textAtomValue'
    ]
  )
  for (const [key, expected] of [
    ['segments', Object.keys(SEGMENTS)],
    ['resources', Object.keys(RESOURCES)],
    ['atoms', Object.keys(ATOMS)],
    ['parts', Object.keys(PARTS)],
    ['buttonPolicies', Object.keys(BUTTON_POLICIES)],
    ['targets', Object.keys(TARGETS)],
    ['flows', Object.keys(FLOWS)]
  ]) {
    assert.deepEqual(Object.keys(baseline.scenarios[key]), expected)
  }
  assert.deepEqual(baseline.scenarios.bots, BOTS)
  assert.equal(baseline.rows.length, 109)

  // Every media branch must be present, or the replay would pass without exercising it.
  assert.deepEqual(
    [...new Set(baseline.rows.filter(row => row.fn === 'outboundMessage')
      .map(row => PARTS[row.args[0]].media))].sort(),
    ['dice', 'forward', 'music', 'picture', 'rps', 'text', 'video', 'voice']
  )
  // Both host-segment outcomes have to appear: a native factory and the OneBot fallback.
  const atoms = baseline.rows.filter(row => row.fn === 'textAtomValue')
  assert.equal(atoms.some(row => JSON.stringify(row.result).includes('"via":"host"')), true)
  assert.equal(atoms.some(row => JSON.stringify(row.result).includes('"qq":"all"')), true)
  // A host that refuses the message must surface as a thrown row, not a quiet success.
  assert.equal(
    baseline.rows.some(row => row.bot === 'throwingSendMsg' &&
      JSON.stringify(row.result).includes('host refused the message')),
    true
  )
})

test('the typed outbound host reproduces every captured legacy row', async () => {
  const baseline = await fixture()
  const actual = await typedRows()
  assert.equal(actual.length, baseline.rows.length)
  const divergences = []
  for (const [index, expected] of baseline.rows.entries()) {
    const row = actual[index]
    if (JSON.stringify(row) !== JSON.stringify(expected)) {
      divergences.push({ index, fn: expected.fn, expected, actual: row })
    }
  }
  assert.deepEqual(divergences, [])
})

test('the migrated outbound helpers have exactly one editable copy', async () => {
  const index = await readFile(new URL('../../index.js', import.meta.url), 'utf8')
  for (const name of ['resourceValue', 'textAtomValue']) {
    assert.equal(
      index.includes(`\nfunction ${name} (`),
      false,
      `${name} still has a legacy definition in index.js`
    )
  }
  assert.equal(index.includes('\nasync function outboundMessage ('), false)
  assert.equal(index.includes('\nconst outboundHost = Object.freeze({'), false)
  assert.match(index, /from '\.\/dist\/runtime\/host\/host-outbound\.js'/)
  // The typed materializers index.js used to name are now the migrated module's own imports.
  for (const gone of [
    'yunzai-music-segment.js', 'yunzai-magic-segment.js', 'yunzai-forward-message.js',
    'yunzai-button-content.js'
  ]) {
    assert.equal(index.includes(gone), false, `index.js still imports ${gone}`)
  }
  // The host segment factory must still be bound at exactly one place.
  assert.match(index, /segment: \(\) => globalThis\.segment/)
})
