import { randomBytes } from 'node:crypto'
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite'
import {
  createMemoryAccessCapabilityIssuerV1,
  issueMemoryAccessCapabilityV1,
  type MemoryAccessContextV1
} from './memory-access-gate.js'
import {
  createMemoryLifecycleAuthorityRootV1,
  issueMemoryMaintenanceCapabilityV1
} from './memory-lifecycle-authority.js'
import {
  createMemoryMaintenanceCommandV1,
  createMemoryMaintenancePortV1
} from './memory-maintenance-port.js'
import {
  memoryNamespaceRefV1,
  parseMemoryNamespaceV1,
  type MemoryNamespaceV1
} from './memory-namespace.js'
import { createSqliteMemoryMaintenanceAdapterV1 } from './sqlite-memory-maintenance.js'
import { createSqliteMemoryOutboxV1 } from './sqlite-memory-outbox.js'

const BATCH_RECORDS = 32
const MAX_CHECKPOINTS = 4
const MAX_SCRUB_BATCHES = 8
const BUDGET_MS = 250
const OWNER = 'groupmate-production-memory-deletion'

interface DeletionOptions {
  readonly database: DatabaseSync
  readonly botInstanceId: string
  readonly now: () => string
  readonly rebuildLexical: () => Promise<number>
}

type Row = Record<string, SQLOutputValue>

/** No timers or worker: commands and startup resume only durable deletion receipts. */
export function createSqlitePersonalMemoryDeletionCleanupV1 (options: DeletionOptions): {
  readonly resume: (namespace?: MemoryNamespaceV1) => Promise<boolean>
  readonly hasPending: () => boolean
} {
  const database = options.database
  const now = (): string => {
    const highWater = Number(database.prepare(`
      SELECT trusted_time_high_water_ms FROM lifecycle_deployment_state WHERE singleton = 1
    `).get()?.trusted_time_high_water_ms)
    return new Date(Math.max(Date.parse(options.now()), highWater)).toISOString()
  }
  const maintenance = createMemoryMaintenancePortV1({ now,
    execute: createSqliteMemoryMaintenanceAdapterV1({ database, now }).execute })
  const outbox = createSqliteMemoryOutboxV1({ database, now })

  const pending = (namespace?: MemoryNamespaceV1): Row[] => database.prepare(`
    SELECT c.namespace_ref, c.deletion_ref, c.deleting_generation,
      n.namespace_generation, n.namespace_wire, n.namespace_wire_bytes
    FROM namespace_deletion_checkpoints c JOIN namespaces n
      ON n.namespace_ref = c.namespace_ref
    WHERE c.deleting_generation < n.namespace_generation
      AND (c.stage != 'canonical_complete' OR c.derived_cleanup != 'applied')
      ${namespace === undefined ? '' : 'AND c.namespace_ref = ?'}
    ORDER BY c.namespace_ref, c.stage, c.updated_at_ms, c.deletion_ref LIMIT ${MAX_CHECKPOINTS}
  `).all(...(namespace === undefined ? [] : [memoryNamespaceRefV1(namespace)])) as Row[]

  const resume = async (requestedNamespace?: MemoryNamespaceV1): Promise<boolean> => {
    const until = Date.now() + BUDGET_MS
    let batches = 0
    let rebuilt = false
    try {
      for (const row of pending(requestedNamespace)) {
        const wire = String(row.namespace_wire)
        if (Buffer.byteLength(wire) !== row.namespace_wire_bytes) return false
        const namespace = parseMemoryNamespaceV1(JSON.parse(wire))
        const namespaceRef = memoryNamespaceRefV1(namespace)
        const generation = Number(row.namespace_generation)
        const targetGeneration = Number(row.deleting_generation)
        const deletionRef = String(row.deletion_ref)
        if (namespace.botInstanceId !== options.botInstanceId || namespace.scope.kind !== 'personal' ||
          namespaceRef !== row.namespace_ref || !Number.isSafeInteger(generation) ||
          !Number.isSafeInteger(targetGeneration) || targetGeneration < 1 || targetGeneration >= generation) {
          return false
        }
        const subject = namespace.scope.subjectUserId
        const issuer = createMemoryAccessCapabilityIssuerV1((context: MemoryAccessContextV1) =>
          context.botInstanceId === namespace.botInstanceId && context.accountId === namespace.accountId &&
          context.scene.kind === 'private' && context.scene.peerUserId === subject)
        const root = createMemoryLifecycleAuthorityRootV1(request =>
          request.kind === 'maintenance' && request.context.namespaceRef === namespaceRef &&
          request.context.botInstanceId === namespace.botInstanceId &&
          request.context.accountId === namespace.accountId &&
          request.context.currentGeneration === generation && request.context.limit === BATCH_RECORDS &&
          ((request.context.operation === 'deletion.checkpoint' &&
            request.context.targetGeneration === generation && request.context.deletionRef === null) ||
           (['namespace.scrubDeleted', 'namespace.verifyScrubbed'].includes(request.context.operation) &&
            request.context.targetGeneration === targetGeneration && request.context.deletionRef === deletionRef)))
        const execute = async (operation: 'namespace.scrubDeleted' | 'namespace.verifyScrubbed' | 'deletion.checkpoint') => {
          const instant = now()
          const checkpoint = operation === 'deletion.checkpoint'
          const command = createMemoryMaintenanceCommandV1({
            commandRef: `command:${randomBytes(32).toString('hex')}`, operation, namespaceRef,
            currentGeneration: generation, targetGeneration: checkpoint ? generation : targetGeneration,
            deletionRef: checkpoint ? null : deletionRef, limit: BATCH_RECORDS, occurredAt: instant
          })
          return await maintenance.execute({ schemaVersion: 1, command,
            access: issueMemoryAccessCapabilityV1(issuer, { schemaVersion: 1,
              botInstanceId: namespace.botInstanceId, adapter: 'qq', accountId: namespace.accountId,
              scene: { kind: 'private', peerUserId: subject } }, [namespace], instant),
            maintenance: issueMemoryMaintenanceCapabilityV1(root, { schemaVersion: 1,
              botInstanceId: namespace.botInstanceId, adapter: 'qq', accountId: namespace.accountId,
              namespace, namespaceRef, currentGeneration: generation,
              targetGeneration: checkpoint ? generation : targetGeneration,
              deletionRef: checkpoint ? null : deletionRef, operation, limit: BATCH_RECORDS }, instant) })
        }
        for (;;) {
          if (batches >= MAX_SCRUB_BATCHES || Date.now() >= until) return false
          batches += 1
          const scrubbed = await execute('namespace.scrubDeleted')
          if (scrubbed.status !== 'completed') return false
          if (!scrubbed.hasMore) break
        }
        if ((await execute('namespace.verifyScrubbed')).status !== 'completed') return false
        if (!rebuilt) {
          await options.rebuildLexical()
          rebuilt = true
        }
        // Only acknowledge this deletion's metadata event after the lexical rebuild.
        // Other accounts and newly created records are never leased or acknowledged here.
        const claimed = await outbox.execute({ schemaVersion: 1, operation: 'claim_namespace_deletion',
          ownerId: OWNER, namespaceRef, namespaceGeneration: targetGeneration + 1, limit: BATCH_RECORDS })
        if (claimed.status === 'claimed') {
          for (const event of claimed.events) {
            const ack = await outbox.execute({ schemaVersion: 1, operation: 'ack', ownerId: OWNER,
              leaseToken: claimed.leaseToken, eventId: event.eventId, sequence: event.sequence })
            if (ack.status !== 'acked') return false
          }
        } else if (claimed.status !== 'empty') return false
        if ((await execute('deletion.checkpoint')).status !== 'completed') return false
      }
      return pending(requestedNamespace).length === 0
    } catch {
      // Logical deletion remains fenced when cleanup cannot finish; callers must not report completion.
      return false
    }
  }
  return Object.freeze({ resume, hasPending: () => {
    try { return pending().length > 0 } catch { return true }
  } })
}
