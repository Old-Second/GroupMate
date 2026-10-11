export type RunBoundary = 'provider' | 'tool' | 'response' | 'final'
export type RunBoundaryGuard = (boundary: RunBoundary, signal: AbortSignal) => Promise<void>

// These closures are runtime authority. They must never be serialized or reconstructed from model data.
const guards = new WeakMap<object, RunBoundaryGuard>()
const finalObservers = new WeakMap<object, (delivered: boolean) => void>()
export function bindRunFinalDelivery<T extends object> (value: T, observer?: (delivered: boolean) => void): T {
  if (observer !== undefined) finalObservers.set(value, observer)
  return value
}
export function notifyRunFinalDelivery (value: object, delivered: boolean): void {
  const observer = finalObservers.get(value)
  finalObservers.delete(value)
  try { observer?.(delivered) } catch { /* Delivery already settled; cleanup cannot change its result. */ }
}
export function bindRunBoundaryGuard<T extends object> (value: T, guard?: RunBoundaryGuard): T {
  if (guard !== undefined) guards.set(value, guard)
  return value
}
export function runBoundaryGuard (value: object): RunBoundaryGuard | undefined { return guards.get(value) }
export function transferRunBoundaryGuard<T extends object> (source: object, target: T): T {
  return bindRunBoundaryGuard(target, guards.get(source))
}
