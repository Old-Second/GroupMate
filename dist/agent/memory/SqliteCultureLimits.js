import { CULTURE_LIMITS, CULTURE_LABELS, cultureKindV1 } from '../contracts/CultureRecord.js';
/** Call inside the existing BEGIN IMMEDIATE transaction, after idempotency replay. */
export function culturePendingCapacityV1(database, namespaceRef, generation) {
    const row = database.prepare(`SELECT count(*) AS n FROM proposals
    WHERE namespace_ref = ? AND namespace_generation = ? AND state = 'pending'
    AND json_extract(proposal_wire, '$.kind') = 'group_culture'`).get(namespaceRef, generation);
    return typeof row?.n === 'number' && row.n < CULTURE_LIMITS.pending;
}
export function cultureRecordCapacityV1(database, namespaceRef, generation) {
    const row = database.prepare(`SELECT count(*) AS n FROM heads h JOIN revision_payloads p
    ON p.namespace_ref = h.namespace_ref AND p.namespace_generation = h.namespace_generation
    AND p.memory_id = h.memory_id AND p.revision = h.current_revision
    WHERE h.namespace_ref = ? AND h.namespace_generation = ?
    AND json_extract(p.revision_wire, '$.record.kind') = 'group_culture'`).get(namespaceRef, generation);
    return typeof row?.n === 'number' && row.n < CULTURE_LIMITS.records;
}
export function cultureSubtypeAvailableV1(database, namespaceRef, generation, text, nowMs) {
    const kind = cultureKindV1(text);
    if (kind === null)
        return true;
    const row = database.prepare(`SELECT 1 FROM heads h JOIN revision_payloads p
    ON p.namespace_ref = h.namespace_ref AND p.namespace_generation = h.namespace_generation
    AND p.memory_id = h.memory_id AND p.revision = h.current_revision
    WHERE h.namespace_ref = ? AND h.namespace_generation = ? AND h.valid_until_ms > ?
    AND json_extract(p.revision_wire, '$.record.kind') = 'group_culture'
    AND instr(json_extract(p.revision_wire, '$.record.text'), ?) = 1 LIMIT 1`).get(namespaceRef, generation, nowMs, `本群${CULTURE_LABELS[kind]}：`);
    return row === undefined;
}
