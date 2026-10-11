export type RunBoundary = 'provider' | 'tool' | 'response' | 'final'
export type RunBoundaryGuard = (boundary: RunBoundary, signal: AbortSignal) => Promise<void>

// These closures are runtime authority. They must never be serialized or reconstructed from model data.
const guards = new WeakMap<object, RunBoundaryGuard>()
export function bindRunBoundaryGuard<T extends object> (value: T, guard?: RunBoundaryGuard): T {
  if (guard !== undefined) guards.set(value, guard)
  return value
}
export function runBoundaryGuard (value: object): RunBoundaryGuard | undefined { return guards.get(value) }
export function transferRunBoundaryGuard<T extends object> (source: object, target: T): T {
  return bindRunBoundaryGuard(target, guards.get(source))
}
