import { types as utilTypes } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import {
  decodeMemoryLifecycleCommandWireV1,
  parseMemoryLifecycleCommandV1
} from './memory-lifecycle-command.js'
import type {
  MemoryLifecycleAdapterV1,
  MemoryLifecycleAuthorizationEnvelopeV1
} from './memory-lifecycle-port.js'
import { invalidMemoryValue } from './memory-namespace.js'
import {
  createSqliteMemoryLifecycleMutationAdapterV1
} from './sqlite-memory-lifecycle-mutation.js'
import {
  createSqliteMemoryLifecycleProposalAdapterV1
} from './sqlite-memory-lifecycle-proposal.js'

interface CreateSqliteMemoryLifecycleAdapterOptionsV1 {
  readonly database: DatabaseSync
  readonly now: () => string
}

export function createSqliteMemoryLifecycleAdapterV1 (
  options: CreateSqliteMemoryLifecycleAdapterOptionsV1
): MemoryLifecycleAdapterV1 {
  if (options === null || typeof options !== 'object' || utilTypes.isProxy(options) ||
    options.database === null || typeof options.database !== 'object' ||
    utilTypes.isProxy(options.database) || typeof options.now !== 'function' ||
    utilTypes.isProxy(options.now)) return invalidMemoryValue()
  const direct = createSqliteMemoryLifecycleProposalAdapterV1(options)
  const mutation = createSqliteMemoryLifecycleMutationAdapterV1(options)
  return Object.freeze({
    execute: async (
      envelope: MemoryLifecycleAuthorizationEnvelopeV1,
      signal?: AbortSignal
    ): Promise<unknown> => {
      const command = parseMemoryLifecycleCommandV1(envelope.command)
      const wire = decodeMemoryLifecycleCommandWireV1(command.wire)
      return wire.operation === 'proposal.createAndApprove'
        ? direct.execute(envelope, signal)
        : mutation.execute(envelope, signal)
    }
  })
}
