import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createInitialRunObservationCounters,
  terminalObservationId,
  type RunTerminalSnapshotV2
} from '../../src/agent/run/run-observation.js'
import type { TerminalCommitReceiptV1 } from '../../src/agent/run/run-store.js'
import { TerminalFactCollector } from '../../src/runtime/terminal-fact-collector.js'

const runRef = 'b'.repeat(32)
const revision = 4
const observationId = terminalObservationId(runRef, revision)

function facts (
  valueRunRef = runRef,
  valueRevision = revision
): readonly [RunTerminalSnapshotV2, TerminalCommitReceiptV1] {
  const valueObservationId = terminalObservationId(valueRunRef, valueRevision)
  const counters = createInitialRunObservationCounters()
  return [Object.freeze({
    schemaVersion: 2,
    observationId: valueObservationId,
    runRef: valueRunRef,
    revision: valueRevision,
    status: 'completed',
    finishedAt: '2026-07-16T00:00:00.000Z',
    completion: Object.freeze({ kind: 'reply_text', lengthBucket: '1_40' }),
    errorCode: null,
    cancellationReason: null,
    counters,
    engineDurationMs: counters.engineActiveDurationMs
  }), Object.freeze({
    schemaVersion: 1,
    observationId: valueObservationId,
    runRef: valueRunRef,
    revision: valueRevision,
    deletedKeyCount: 2,
    createdKeyCount: 1,
    checkpointBytesDeleted: 120,
    eventBytesDeleted: 80,
    tombstoneBytes: 240
  })]
}

test('terminal fact collector pairs independent facts once in either order', () => {
  const committed: Array<readonly [RunTerminalSnapshotV2, TerminalCommitReceiptV1]> = []
  const collector = new TerminalFactCollector({
    onCommitted: (snapshot, receipt) => { committed.push([snapshot, receipt]) }
  })
  const [snapshot, receipt] = facts()

  collector.acceptCommitReceipt(receipt)
  assert.equal(committed.length, 0)
  collector.acceptSnapshot(snapshot)
  collector.acceptSnapshot(snapshot)
  collector.acceptCommitReceipt(receipt)

  assert.deepEqual(committed, [[snapshot, receipt]])
})

test('terminal fact collector refuses mismatched identities', () => {
  let calls = 0
  const collector = new TerminalFactCollector({
    onCommitted: () => { calls += 1 }
  })
  const [snapshot, receipt] = facts()
  collector.acceptSnapshot(snapshot)
  collector.acceptCommitReceipt(facts('c'.repeat(32))[1])

  assert.equal(calls, 0)
})

test('terminal fact collector bounds partial and completed identity state with LRU eviction', () => {
  const committed: string[] = []
  const collector = new TerminalFactCollector({
    capacity: 2,
    onCommitted: snapshot => { committed.push(snapshot.observationId) }
  })
  const first = facts('1'.repeat(32))
  const second = facts('2'.repeat(32))
  const third = facts('3'.repeat(32))

  collector.acceptSnapshot(first[0])
  collector.acceptCommitReceipt(first[1])
  collector.acceptSnapshot(second[0])
  collector.acceptCommitReceipt(second[1])
  collector.acceptSnapshot(third[0])
  collector.acceptCommitReceipt(third[1])
  collector.acceptCommitReceipt(first[1])
  collector.acceptSnapshot(first[0])

  assert.deepEqual(committed, [
    first[0].observationId,
    second[0].observationId,
    third[0].observationId,
    first[0].observationId
  ])
})

test('default terminal fact collector retains exactly 256 recent committed identities', () => {
  const committed: string[] = []
  const collector = new TerminalFactCollector({
    onCommitted: snapshot => { committed.push(snapshot.observationId) }
  })
  const entries = Array.from({ length: 257 }, (_, index) => (
    facts((index + 1).toString(16).padStart(32, '0'))
  ))

  for (const [snapshot, receipt] of entries.slice(0, 256)) {
    collector.acceptSnapshot(snapshot)
    collector.acceptCommitReceipt(receipt)
  }
  assert.equal(committed.length, 256)

  collector.acceptCommitReceipt(entries[0]?.[1] as TerminalCommitReceiptV1)
  collector.acceptSnapshot(entries[0]?.[0] as RunTerminalSnapshotV2)
  assert.equal(committed.length, 256)

  collector.acceptSnapshot(entries[256]?.[0] as RunTerminalSnapshotV2)
  collector.acceptCommitReceipt(entries[256]?.[1] as TerminalCommitReceiptV1)
  collector.acceptCommitReceipt(entries[1]?.[1] as TerminalCommitReceiptV1)
  collector.acceptSnapshot(entries[1]?.[0] as RunTerminalSnapshotV2)

  assert.equal(committed.length, 258)
  assert.equal(committed.at(-1), entries[1]?.[0].observationId)
})

test('terminal fact collector ignores malformed facts and never invents a pair', () => {
  let calls = 0
  const collector = new TerminalFactCollector({
    onCommitted: () => { calls += 1 }
  })
  const [snapshot, receipt] = facts()

  assert.doesNotThrow(() => collector.acceptSnapshot({
    ...snapshot,
    observationId: observationId.slice(1)
  }))
  assert.doesNotThrow(() => collector.acceptCommitReceipt({
    ...receipt,
    tombstoneBytes: -1
  }))
  assert.equal(calls, 0)
})
