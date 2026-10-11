// These closures are runtime authority. They must never be serialized or reconstructed from model data.
const guards = new WeakMap();
export function bindRunBoundaryGuard(value, guard) {
    if (guard !== undefined)
        guards.set(value, guard);
    return value;
}
export function runBoundaryGuard(value) { return guards.get(value); }
export function transferRunBoundaryGuard(source, target) {
    return bindRunBoundaryGuard(target, guards.get(source));
}
