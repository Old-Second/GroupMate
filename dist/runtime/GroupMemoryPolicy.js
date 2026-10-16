import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
export const GROUP_MEMORY_POLICY_SQLITE_APPLICATION_ID_V1 = 0x474d4750;
const SCHEMA_VERSION = 1;
const MAXIMUM_POLICIES = 8_192;
const FEATURES = Object.freeze(['group_memory', 'group_culture']);
const SCHEMA_SQL = `CREATE TABLE group_memory_policies(
  bot_instance_id TEXT NOT NULL CHECK(length(bot_instance_id) BETWEEN 1 AND 128),
  account_id TEXT NOT NULL CHECK(length(account_id) BETWEEN 1 AND 32),
  group_id TEXT NOT NULL CHECK(length(group_id) BETWEEN 1 AND 32),
  feature TEXT NOT NULL CHECK(feature IN ('group_memory', 'group_culture')),
  state TEXT NOT NULL CHECK(state IN ('enabled', 'disabled')),
  policy_generation INTEGER NOT NULL CHECK(policy_generation > 0),
  decided_by_actor_ref_hash TEXT NOT NULL CHECK(length(decided_by_actor_ref_hash) = 64),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  PRIMARY KEY(bot_instance_id, account_id, group_id, feature)
) STRICT, WITHOUT ROWID`;
function pragma(database, name) {
    const value = Object.values(database.prepare(`PRAGMA ${name}`).get() ?? {})[0];
    if (typeof value !== 'number' || !Number.isSafeInteger(value))
        throw new TypeError('group memory policy store is invalid');
    return value;
}
function scopeValues(scope) {
    if (typeof scope?.botInstanceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(scope.botInstanceId) ||
        typeof scope.accountId !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(scope.accountId) ||
        typeof scope.groupId !== 'string' || !/^[1-9][0-9]{0,31}$/u.test(scope.groupId)) {
        throw new TypeError('group memory policy scope is invalid');
    }
    return [scope.botInstanceId, scope.accountId, scope.groupId];
}
/**
 * Group memory and culture default on in every group. Only an explicit current
 * administrator command stores a durable opt-out; it is kept outside canonical
 * memory so namespace deletion and bot rejoin cannot silently reopen a group.
 */
export function openGroupMemoryPolicyStoreV1(location) {
    const database = new DatabaseSync(location);
    try {
        chmodSync(location, 0o600);
        database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 50; PRAGMA cache_size = -64');
        const applicationId = pragma(database, 'application_id');
        const version = pragma(database, 'user_version');
        const objects = Number(database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()?.n);
        if (applicationId === 0 && version === 0 && objects === 0) {
            database.exec('BEGIN IMMEDIATE');
            try {
                database.exec(SCHEMA_SQL);
                database.exec(`PRAGMA application_id = ${GROUP_MEMORY_POLICY_SQLITE_APPLICATION_ID_V1}`);
                database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
                database.exec('COMMIT');
            }
            catch (error) {
                try {
                    database.exec('ROLLBACK');
                }
                catch { }
                throw error;
            }
        }
        else if (applicationId !== GROUP_MEMORY_POLICY_SQLITE_APPLICATION_ID_V1 || version !== SCHEMA_VERSION) {
            throw new TypeError('group memory policy store is invalid');
        }
        const schema = database.prepare(`SELECT type, name, sql FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%' LIMIT 2`).all();
        if (schema.length !== 1 || schema[0].type !== 'table' ||
            schema[0].name !== 'group_memory_policies' || schema[0].sql !== SCHEMA_SQL) {
            throw new TypeError('group memory policy store is invalid');
        }
    }
    catch (error) {
        database.close();
        throw error;
    }
    const select = database.prepare(`SELECT feature, state, policy_generation FROM group_memory_policies
    WHERE bot_instance_id = ? AND account_id = ? AND group_id = ?`);
    const read = (scope) => {
        const policy = {
            group_memory: Object.freeze({ enabled: true, generation: 0 }),
            group_culture: Object.freeze({ enabled: true, generation: 0 })
        };
        for (const row of select.all(...scopeValues(scope))) {
            const feature = FEATURES.find(value => value === row.feature);
            const generation = row.policy_generation;
            if (feature === undefined || (row.state !== 'enabled' && row.state !== 'disabled') ||
                typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) {
                throw new TypeError('group memory policy row is invalid');
            }
            policy[feature] = Object.freeze({ enabled: row.state === 'enabled', generation });
        }
        return Object.freeze(policy);
    };
    return Object.freeze({
        read,
        decide(scope, feature, enabled, actorRef, now) {
            const values = scopeValues(scope);
            const updatedAt = Date.parse(now);
            if (!FEATURES.includes(feature) || typeof enabled !== 'boolean' || typeof actorRef !== 'string' ||
                actorRef.length === 0 || !Number.isSafeInteger(updatedAt) || updatedAt < 0) {
                throw new TypeError('group memory policy decision is invalid');
            }
            database.exec('BEGIN IMMEDIATE');
            try {
                const current = read(scope);
                if (current[feature].enabled === enabled) {
                    database.exec('ROLLBACK');
                    return Object.freeze({ status: 'unchanged', policy: current });
                }
                if (current[feature].generation === 0 &&
                    Number(database.prepare('SELECT count(*) AS n FROM group_memory_policies').get()?.n) >= MAXIMUM_POLICIES) {
                    database.exec('ROLLBACK');
                    return Object.freeze({ status: 'capacity', policy: current });
                }
                const generation = current[feature].generation + 1;
                database.prepare(`INSERT INTO group_memory_policies(bot_instance_id, account_id, group_id, feature,
            state, policy_generation, decided_by_actor_ref_hash, updated_at_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(bot_instance_id, account_id, group_id, feature) DO UPDATE SET
            state = excluded.state, policy_generation = excluded.policy_generation,
            decided_by_actor_ref_hash = excluded.decided_by_actor_ref_hash, updated_at_ms = excluded.updated_at_ms`)
                    .run(...values, feature, enabled ? 'enabled' : 'disabled', generation, createHash('sha256').update(actorRef).digest('hex'), updatedAt);
                const policy = read(scope);
                database.exec('COMMIT');
                return Object.freeze({ status: 'stored', policy });
            }
            catch (error) {
                try {
                    database.exec('ROLLBACK');
                }
                catch { }
                throw error;
            }
        },
        close: () => { database.close(); }
    });
}
