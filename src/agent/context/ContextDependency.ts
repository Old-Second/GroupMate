import { parseJsonValue } from '../model/json-value.js'

export interface MemoryDependency {
  readonly namespaceRef: string
  readonly memoryId: string
  readonly revision: number
  readonly revisionHash: string
}

/** Evidence describes inputs; only a host validator can grant current authority. */
export interface SceneDependency {
  readonly botId: string
  readonly groupId: string
  readonly actorId: string
  readonly botJoinedAt: number
  readonly actorJoinedAt: number
}

export interface ContextDependencyProof {
  readonly scene?: SceneDependency
  readonly schemaVersion: 1
  readonly memories: readonly MemoryDependency[]
  readonly authorityStamp: string | null
}

export function parseContextDependencyProof (value: unknown): ContextDependencyProof {
  const proof = parseJsonValue(value, { maxBytes: 8 * 1024, maxDepth: 4, maxNodes: 256 }) as unknown as ContextDependencyProof
  if (proof === null || typeof proof !== 'object' || Array.isArray(proof) ||
    Object.keys(proof).sort().join(',') !== (proof.scene === undefined ? 'authorityStamp,memories,schemaVersion' : 'authorityStamp,memories,scene,schemaVersion') ||
    proof.schemaVersion !== 1 || !Array.isArray(proof.memories) || proof.memories.length > 12 ||
    (proof.authorityStamp !== null && !/^[a-f0-9]{64}$/.test(proof.authorityStamp))) {
    throw new TypeError('context dependency proof is invalid')
  }
  if (proof.scene !== undefined) {
    const scene = proof.scene
    if (scene === null || typeof scene !== 'object' || Array.isArray(scene) ||
      Object.keys(scene).sort().join(',') !== 'actorId,actorJoinedAt,botId,botJoinedAt,groupId' ||
      [scene.botId, scene.actorId, scene.groupId].some(id => typeof id !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(id)) ||
      !Number.isSafeInteger(scene.botJoinedAt) || scene.botJoinedAt < 0 ||
      !Number.isSafeInteger(scene.actorJoinedAt) || scene.actorJoinedAt < 0) throw new TypeError('context scene dependency is invalid')
    Object.freeze(scene)
  }
  const seen = new Set<string>()
  for (const ref of proof.memories) {
    if (ref === null || typeof ref !== 'object' || Array.isArray(ref) ||
      Object.keys(ref).sort().join(',') !== 'memoryId,namespaceRef,revision,revisionHash' ||
      typeof ref.namespaceRef !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(ref.namespaceRef) ||
      typeof ref.memoryId !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(ref.memoryId) ||
      !Number.isSafeInteger(ref.revision) || ref.revision <= 0 ||
      typeof ref.revisionHash !== 'string' || !/^[a-f0-9]{64}$/.test(ref.revisionHash)) {
      throw new TypeError('context memory dependency is invalid')
    }
    const key = `${ref.namespaceRef}\0${ref.memoryId}`
    if (seen.has(key)) throw new TypeError('duplicate context memory dependency')
    seen.add(key)
    Object.freeze(ref)
  }
  return Object.freeze({ ...proof, memories: Object.freeze([...proof.memories]) })
}
