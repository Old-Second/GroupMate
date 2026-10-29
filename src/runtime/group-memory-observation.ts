import { types as utilTypes } from 'node:util'

/**
 * The Yunzai shell sees every group message before command rules run. It only
 * forwards the event here; the bounded learning runtime decides whether the
 * message is eligible. Observation never replies, throws or blocks the host.
 */
export interface GroupMemoryObservationPortV1 {
  readonly observe: (event: unknown) => void
}

let configuredPort: GroupMemoryObservationPortV1 | null = null

function validPort (value: unknown): value is GroupMemoryObservationPortV1 {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) return false
  const descriptor = Object.getOwnPropertyDescriptor(value, 'observe')
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'function' && !utilTypes.isProxy(descriptor.value)
}

export function configureProductionGroupMemoryObservationPortV1 (
  port: GroupMemoryObservationPortV1
): void {
  if (configuredPort !== null || !validPort(port)) {
    throw new Error('群记忆自动候选观察端口已配置或无效。')
  }
  configuredPort = port
}

export function observeProductionGroupMessageV1 (event: unknown): void {
  try { configuredPort?.observe(event) } catch { /* observation is a side channel: the host message path must never see an error from it */ }
}
