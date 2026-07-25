import { types as utilTypes } from 'node:util'
import type { PersonalMemoryCommandPortV1 } from './personal-memory-command.js'

export type ProductionPersonalMemoryModeV1 = 'off' | 'explicit' | 'shadow' | 'automatic'

export interface ProductionPersonalMemoryRecallSourceV1 {
  readonly recall: (input: unknown, signal?: AbortSignal) => Promise<unknown>
}

export interface ProductionPersonalMemoryOperationsPortV1 {
  readonly inspect: (signal?: AbortSignal) => Promise<unknown>
  readonly execute: (request: unknown, signal?: AbortSignal) => Promise<unknown>
}

export interface ProductionPersonalMemoryRuntimeV1 {
  readonly recallSource: ProductionPersonalMemoryRecallSourceV1
  readonly operations: ProductionPersonalMemoryOperationsPortV1
  readonly commands: PersonalMemoryCommandPortV1
  readonly close: () => Promise<void>
}

export interface ProductionPersonalMemoryRuntimeOptionsV1 {
  readonly botInstanceId: string
  readonly storageDirectory: string
  readonly deploymentMode: () => ProductionPersonalMemoryModeV1
  readonly groupAllowlist: () => readonly string[]
  readonly recallMaxItems: () => number
  readonly recallMaxTokens: () => number
  readonly recallTimeoutMs: () => number
}

export interface ProductionPersonalMemoryRuntimeModuleV1 {
  readonly createProductionPersonalMemoryRuntimeV1: (
    options: ProductionPersonalMemoryRuntimeOptionsV1
  ) => Promise<ProductionPersonalMemoryRuntimeV1>
}

interface InitializeProductionPersonalMemoryRuntimeOptionsV1 extends
ProductionPersonalMemoryRuntimeOptionsV1 {
  readonly loadModule?: () => Promise<ProductionPersonalMemoryRuntimeModuleV1>
}

const MODES = new Set<ProductionPersonalMemoryModeV1>([
  'off', 'explicit', 'shadow', 'automatic'
])

function currentMode (
  source: () => ProductionPersonalMemoryModeV1
): ProductionPersonalMemoryModeV1 | null {
  try {
    const value = Reflect.apply(source, undefined, []) as unknown
    return typeof value === 'string' && MODES.has(value as ProductionPersonalMemoryModeV1)
      ? value as ProductionPersonalMemoryModeV1
      : null
  } catch {
    return null
  }
}

function runtimeModule (
  value: ProductionPersonalMemoryRuntimeModuleV1
): ProductionPersonalMemoryRuntimeModuleV1 {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) {
    throw new TypeError('production personal memory module is invalid')
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, 'createProductionPersonalMemoryRuntimeV1')
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
    typeof descriptor.value !== 'function' || utilTypes.isProxy(descriptor.value)) {
    throw new TypeError('production personal memory module is invalid')
  }
  return value
}

export async function initializeProductionPersonalMemoryRuntimeV1 (
  options: InitializeProductionPersonalMemoryRuntimeOptionsV1
): Promise<ProductionPersonalMemoryRuntimeV1 | null> {
  const mode = currentMode(options.deploymentMode)
  if (mode === null || mode === 'off') return null
  const loadModule = options.loadModule ?? (async () => (
    await import('./production-personal-memory-runtime.js')
  ))
  const module = runtimeModule(await loadModule())
  return await module.createProductionPersonalMemoryRuntimeV1(Object.freeze({
    botInstanceId: options.botInstanceId,
    storageDirectory: options.storageDirectory,
    deploymentMode: options.deploymentMode,
    groupAllowlist: options.groupAllowlist,
    recallMaxItems: options.recallMaxItems,
    recallMaxTokens: options.recallMaxTokens,
    recallTimeoutMs: options.recallTimeoutMs
  }))
}
