import {
  createMemoryOutboxPortV1
} from '../../src/agent/memory/memory-outbox.js'
import {
  createMemoryRepositoryPortV1
} from '../../src/agent/memory/memory-repository.js'
import { registerMemoryPortContract } from '../helpers/memory-repository-contract.js'

/*
 * Expected Task 4 public surface is intentionally small:
 *
 * memory-repository.ts:
 *   MemoryRepositoryRequestV1, MemoryRepositoryResultV1,
 *   MemoryRepositoryPortV1, createMemoryRepositoryPortV1.
 *
 * memory-outbox.ts:
 *   MemoryOutboxRequestV1, MemoryOutboxResultV1,
 *   MemoryOutboxPortV1, createMemoryOutboxPortV1.
 *
 * Storage transactions, CAS concurrency and SQLite accounting belong to Task 6.
 */

registerMemoryPortContract({
  name: 'guarded backend-neutral',
  repository: createMemoryRepositoryPortV1,
  outbox: createMemoryOutboxPortV1
})
