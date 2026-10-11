import { createHash } from 'node:crypto';
import { createSqliteMemoryCanonicalRehydratorV1 } from '../agent/memory/sqlite-memory-canonical-rehydrator.js';
import { parseMemoryNamespaceRefV1 } from '../agent/memory/memory-namespace.js';
/** Recheck original heads, independent of lexical ranking or prompt truncation. */
export async function validateCanonicalMemoryDependencies(database, request, refs, signal) {
    const canonical = createSqliteMemoryCanonicalRehydratorV1({ database, now: () => new Date().toISOString() });
    const allowed = new Set(request.subjects.map(subject => subject.namespaceRef));
    for (const ref of refs) {
        if (signal.aborted || !allowed.has(parseMemoryNamespaceRefV1(ref.namespaceRef)))
            return false;
        const row = database.prepare('SELECT namespace_generation FROM namespaces WHERE namespace_ref = ?').get(ref.namespaceRef);
        if (row === undefined)
            return false;
        const result = await canonical.rehydrate({ capability: request.capability, identity: {
                namespaceRef: ref.namespaceRef, namespaceGeneration: row.namespace_generation,
                memoryId: ref.memoryId, memoryRevision: ref.revision, revisionHash: ref.revisionHash
            } }, signal);
        if (result.status !== 'found' || result.record.deletionState !== 'active' ||
            result.record.validity.state === 'superseded' || result.record.conflict.state === 'confirmed' ||
            Date.parse(result.record.retention.validUntil) <= Date.now())
            return false;
    }
    return !signal.aborted;
}
/** Policy generations make disable/re-enable and namespace deletion invalidate prior derivatives. */
export function canonicalMemoryAuthorityStamp(database, refs, deploymentPolicy) {
    const namespaces = [...new Set(refs.map(ref => ref.namespaceRef))].sort();
    const rows = namespaces.map(ref => {
        const namespace = database.prepare('SELECT namespace_generation FROM namespaces WHERE namespace_ref = ?').get(ref);
        if (namespace === undefined)
            throw new TypeError('memory namespace is missing');
        const policy = database.prepare('SELECT namespace_generation, policy_generation, policy_hash FROM personal_memory_policies WHERE namespace_ref = ?').get(ref);
        return { ref, namespace, policy: policy ?? null };
    });
    return createHash('sha256').update(JSON.stringify({ rows, deploymentPolicy })).digest('hex');
}
