import { randomBytes } from 'node:crypto';
import { createMemoryAccessCapabilityIssuerV1, issueMemoryAccessCapabilityV1 } from '../agent/memory/memory-access-gate.js';
import { createMemoryLifecycleAuthorityRootV1, issueMemoryMaintenanceCapabilityV1 } from '../agent/memory/memory-lifecycle-authority.js';
import { MEMORY_PROPOSAL_DEADLINE_DAYS_V2, MEMORY_RETENTION_PURGE_GRACE_DAYS_V2 } from '../agent/memory/memory-lifecycle-domain.js';
import { createMemoryMaintenanceCommandV1, createMemoryMaintenancePortV1 } from '../agent/memory/memory-maintenance-port.js';
import { memoryNamespaceRefV1, parseMemoryNamespaceV1 } from '../agent/memory/memory-namespace.js';
import { createSqliteMemoryMaintenanceAdapterV1 } from '../agent/memory/sqlite-memory-maintenance.js';
const DAY = 86400000;
const LIMIT = 32;
const QUERIES = [
    ['proposal.expireDue', "SELECT 1 FROM proposals WHERE namespace_ref = ? AND namespace_generation = ? AND state = 'pending' AND proposed_at_ms <= ? LIMIT 1"],
    ['proposal.purgeDecided', "SELECT 1 FROM proposals WHERE namespace_ref = ? AND namespace_generation = ? AND state != 'pending' AND COALESCE(decided_at_ms, proposed_at_ms) <= ? LIMIT 1"],
    ['record.purgeExpired', 'SELECT 1 FROM heads WHERE namespace_ref = ? AND namespace_generation = ? AND purge_at_ms <= ? LIMIT 1'],
    ['tombstone.purgeExpired', 'SELECT 1 FROM tombstones WHERE namespace_ref = ? AND namespace_generation = ? AND expires_at_ms <= ? LIMIT 1'],
    ['audit.purgeExpired', 'SELECT 1 FROM lifecycle_audits WHERE namespace_ref = ? AND namespace_generation = ? AND expires_at_ms <= ? LIMIT 1'],
    ['command.purgeExpired', 'SELECT 1 FROM lifecycle_commands WHERE namespace_ref = ? AND namespace_generation = ? AND expires_at_ms <= ? LIMIT 1'],
    ['export.releaseExpiredReservations', 'SELECT 1 FROM export_audit_reservations WHERE namespace_ref = ? AND namespace_generation = ? AND expires_at_ms <= ? LIMIT 1']
];
/** Four namespaces/32 records per operation, one in-flight batch, no writes for idle stores. */
export function createProductionMemoryRetentionV1(options) {
    const now = () => new Date(Math.max(Date.parse(options.now()), Number(options.database.prepare('SELECT trusted_time_high_water_ms FROM lifecycle_deployment_state WHERE singleton = 1').get()?.trusted_time_high_water_ms ?? 0))).toISOString();
    const maintenance = createMemoryMaintenancePortV1({ now,
        execute: createSqliteMemoryMaintenanceAdapterV1({ database: options.database, now }).execute });
    const root = createMemoryLifecycleAuthorityRootV1(request => request.kind === 'maintenance' &&
        request.context.botInstanceId === options.botInstanceId && request.context.limit === LIMIT &&
        request.context.currentGeneration === request.context.targetGeneration && request.context.deletionRef === null &&
        QUERIES.some(([operation]) => operation === request.context.operation));
    const issuer = createMemoryAccessCapabilityIssuerV1((context) => context.botInstanceId === options.botInstanceId);
    let cursor = '';
    let active = null;
    let closed = false;
    let status = 'idle';
    let lastProcessed = 0;
    let lexicalDirty = false;
    const run = async () => {
        if (closed)
            return 0;
        if (active !== null)
            return await active;
        status = 'idle';
        active = (async () => {
            let processed = 0;
            const until = Date.now() + 250;
            try {
                if (!await options.resumeDeletion())
                    status = 'degraded';
                let rows = options.database.prepare('SELECT namespace_ref, namespace_wire, namespace_generation FROM namespaces WHERE namespace_ref > ? ORDER BY namespace_ref LIMIT 4').all(cursor);
                if (rows.length === 0) {
                    cursor = '';
                    rows = options.database.prepare('SELECT namespace_ref, namespace_wire, namespace_generation FROM namespaces ORDER BY namespace_ref LIMIT 4').all();
                }
                for (const row of rows) {
                    if (closed || Date.now() >= until)
                        break;
                    const namespace = parseMemoryNamespaceV1(JSON.parse(String(row.namespace_wire)));
                    const namespaceRef = memoryNamespaceRefV1(namespace);
                    const generation = Number(row.namespace_generation);
                    cursor = String(row.namespace_ref);
                    if (namespace.botInstanceId !== options.botInstanceId || namespaceRef !== row.namespace_ref)
                        continue;
                    for (const [operation, sql] of QUERIES) {
                        if (closed || Date.now() >= until)
                            break;
                        const instant = now();
                        const time = Date.parse(instant);
                        const threshold = operation === 'proposal.expireDue' ? time - MEMORY_PROPOSAL_DEADLINE_DAYS_V2 * DAY
                            : operation === 'proposal.purgeDecided' ? time -
                                (MEMORY_PROPOSAL_DEADLINE_DAYS_V2 + MEMORY_RETENTION_PURGE_GRACE_DAYS_V2) * DAY : time;
                        if (!options.database.prepare(sql).get(namespaceRef, generation, threshold))
                            continue;
                        const scene = namespace.scope.kind === 'personal'
                            ? { kind: 'private', peerUserId: namespace.scope.subjectUserId }
                            : { kind: 'group', groupId: namespace.scope.groupId, groupLifecycleId: namespace.scope.groupLifecycleId,
                                trustedMemberUserIds: [], observedAt: instant };
                        const context = { schemaVersion: 1, botInstanceId: namespace.botInstanceId, adapter: 'qq',
                            accountId: namespace.accountId, scene };
                        const result = await maintenance.execute({ schemaVersion: 1,
                            command: createMemoryMaintenanceCommandV1({ commandRef: `command:${randomBytes(32).toString('hex')}`,
                                operation, namespaceRef, currentGeneration: generation, targetGeneration: generation,
                                deletionRef: null, limit: LIMIT, occurredAt: instant }),
                            access: issueMemoryAccessCapabilityV1(issuer, context, [namespace], instant),
                            maintenance: issueMemoryMaintenanceCapabilityV1(root, { schemaVersion: 1,
                                botInstanceId: namespace.botInstanceId, adapter: 'qq', accountId: namespace.accountId,
                                namespace, namespaceRef, currentGeneration: generation, targetGeneration: generation,
                                deletionRef: null, operation, limit: LIMIT }, instant) });
                        if (result.status === 'completed') {
                            processed += result.processed;
                            if (operation === 'record.purgeExpired' && result.processed > 0)
                                lexicalDirty = true;
                        }
                        else
                            status = 'degraded';
                    }
                }
                if (lexicalDirty) {
                    await options.rebuildLexical();
                    lexicalDirty = false;
                    options.database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
                }
            }
            catch {
                // A retention/index/storage failure cannot change ordinary chat or QQ delivery.
                status = 'degraded';
            }
            lastProcessed = processed;
            if (status !== 'degraded')
                status = 'completed';
            return processed;
        })();
        try {
            return await active;
        }
        finally {
            active = null;
        }
    };
    let timer = null;
    return Object.freeze({ run,
        inspect: () => Object.freeze({ status, running: active !== null, lastProcessedRecords: lastProcessed }),
        start: () => {
            if (closed || timer !== null)
                return;
            timer = setInterval(() => { void run(); }, 60000);
            timer.unref();
        },
        close: async () => {
            closed = true;
            if (timer !== null)
                clearInterval(timer);
            timer = null;
            await active;
        }
    });
}
