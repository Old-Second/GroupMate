// These closures are runtime authority. They must never be serialized or reconstructed from model data.
const guards = new WeakMap();
const finalObservers = new WeakMap();
export function bindRunFinalDelivery(value, observer) {
    if (observer !== undefined)
        finalObservers.set(value, observer);
    return value;
}
export function notifyRunFinalDelivery(value, delivered) {
    const observer = finalObservers.get(value);
    finalObservers.delete(value);
    try {
        observer?.(delivered);
    }
    catch { /* Delivery already settled; cleanup cannot change its result. */ }
}
export function bindRunBoundaryGuard(value, guard) {
    if (guard !== undefined)
        guards.set(value, guard);
    return value;
}
export function runBoundaryGuard(value) { return guards.get(value); }
export function transferRunBoundaryGuard(source, target) {
    return bindRunBoundaryGuard(target, guards.get(source));
}
