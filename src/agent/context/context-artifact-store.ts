import type { ContextArtifactV1 } from './context-artifact.js'

export type ContextArtifactStoreResult =
  | Readonly<{ readonly status: 'ready'; readonly artifact: ContextArtifactV1 }>
  | Readonly<{ readonly status: 'missing' }>
  | Readonly<{
      readonly status: 'unavailable'
      readonly code: ContextArtifactStoreUnavailableCode
    }>

export type ContextArtifactStoreUnavailableCode =
  | 'redis_unavailable'
  | 'artifact_corrupt'
  | 'metadata_corrupt'
  | 'namespace_capacity'
  | 'reconcile_conflict'
  | 'reconcile_incomplete'

export interface ContextArtifactStore {
  get(artifactId: string): Promise<ContextArtifactStoreResult>
  putIfAbsent(
    artifact: ContextArtifactV1,
    minimumExpiresAtMs: number
  ): Promise<ContextArtifactStoreResult>
  touchAtLeast(
    expectedArtifact: ContextArtifactV1,
    minimumExpiresAtMs: number
  ): Promise<ContextArtifactStoreResult>
}
