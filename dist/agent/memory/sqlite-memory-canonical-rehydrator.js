import { types as utilTypes } from 'node:util';
import { createMemoryCanonicalRehydratorV1 } from './memory-canonical-rehydrator.js';
import { inspectMemoryRecord, invalidMemoryValue } from './memory-namespace.js';
import { createSqliteMemoryHeadSourceV1 } from './sqlite-memory-head-reader.js';
function methodIsDataFunction(value, name) {
    let current = value;
    while (current !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(current, name);
        if (descriptor !== undefined) {
            return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function' &&
                !utilTypes.isProxy(descriptor.value);
        }
        current = Object.getPrototypeOf(current);
    }
    return false;
}
function parseOptions(value) {
    const input = inspectMemoryRecord(value, ['database', 'now']);
    if (input.database === null || typeof input.database !== 'object' ||
        utilTypes.isProxy(input.database) ||
        !methodIsDataFunction(input.database, 'prepare') ||
        typeof input.now !== 'function' || utilTypes.isProxy(input.now)) {
        return invalidMemoryValue();
    }
    return Object.freeze({
        database: input.database,
        now: input.now
    });
}
function verifyCurrent(database, identity) {
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
  `).get(identity.namespaceRef, identity.namespaceGeneration, identity.memoryId, identity.memoryRevision, identity.revisionHash, identity.revisionHash);
    return row?.current === 1;
}
export function createSqliteMemoryCanonicalRehydratorV1(optionsValue) {
    const options = parseOptions(optionsValue);
    return createMemoryCanonicalRehydratorV1({
        source: createSqliteMemoryHeadSourceV1(options),
        verifier: Object.freeze({
            verify: async (identity, signal) => {
                if (signal?.aborted === true)
                    return Object.freeze({ status: 'aborted' });
                try {
                    return verifyCurrent(options.database, identity)
                        ? Object.freeze({ status: 'current' })
                        : Object.freeze({ status: 'stale' });
                }
                catch {
                    return Object.freeze({ status: 'unavailable' });
                }
            }
        }),
        now: options.now
    });
}
