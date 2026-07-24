import type { DatabaseSync } from 'node:sqlite'
import { types as utilTypes } from 'node:util'
import {
  createMemoryCanonicalRehydratorV1,
  type MemoryCanonicalIdentityV1,
  type MemoryCanonicalRehydratorV1
} from './memory-canonical-rehydrator.js'
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js'
import { createSqliteMemoryHeadSourceV1 } from './sqlite-memory-head-reader.js'

interface CreateSqliteMemoryCanonicalRehydratorOptionsV1 {
  readonly database: DatabaseSync
  readonly now: () => string
}

function methodIsDataFunction (value: object, name: string): boolean {
  let current: object | null = value
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name)
    if (descriptor !== undefined) {
      return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function' &&
        !utilTypes.isProxy(descriptor.value)
    }
    current = Object.getPrototypeOf(current) as object | null
  }
  return false
}

function parseOptions (
  value: CreateSqliteMemoryCanonicalRehydratorOptionsV1
): CreateSqliteMemoryCanonicalRehydratorOptionsV1 {
  const input = inspectMemoryRecord(value, ['database', 'now'])
  if (input.database === null || typeof input.database !== 'object' ||
    utilTypes.isProxy(input.database) ||
    !methodIsDataFunction(input.database, 'prepare') ||
    typeof input.now !== 'function' || utilTypes.isProxy(input.now)) {
    return invalidMemoryValue()
  }
  return Object.freeze({
    database: input.database as DatabaseSync,
    now: input.now as () => string
  })
}

function verifyCurrent (
  database: DatabaseSync,
  identity: MemoryCanonicalIdentityV1
): boolean {
  const row = database.prepare(`
    SELECT 1 AS current
    FROM namespaces AS n
    JOIN heads AS h
      ON h.namespace_ref = n.namespace_ref
     AND h.namespace_generation = n.namespace_generation
    JOIN revisions AS r
      ON r.namespace_ref = h.namespace_ref
     AND r.namespace_generation = h.namespace_generation
     AND r.memory_id = h.memory_id
     AND r.revision = h.current_revision
    WHERE n.namespace_ref = ?
      AND n.namespace_generation = ?
      AND h.memory_id = ?
      AND h.current_revision = ?
      AND h.current_revision_hash = ?
      AND r.revision_hash = ?
    LIMIT 1
  `).get(
    identity.namespaceRef,
    identity.namespaceGeneration,
    identity.memoryId,
    identity.memoryRevision,
    identity.revisionHash,
    identity.revisionHash
  )
  return row?.current === 1
}

export function createSqliteMemoryCanonicalRehydratorV1 (
  optionsValue: CreateSqliteMemoryCanonicalRehydratorOptionsV1
): MemoryCanonicalRehydratorV1 {
  const options = parseOptions(optionsValue)
  return createMemoryCanonicalRehydratorV1({
    source: createSqliteMemoryHeadSourceV1(options),
    verifier: Object.freeze({
      verify: async (identity: MemoryCanonicalIdentityV1, signal?: AbortSignal) => {
        if (signal?.aborted === true) return Object.freeze({ status: 'aborted' as const })
        try {
          return verifyCurrent(options.database, identity)
            ? Object.freeze({ status: 'current' as const })
            : Object.freeze({ status: 'stale' as const })
        } catch {
          return Object.freeze({ status: 'unavailable' as const })
        }
      }
    }),
    now: options.now
  })
}
