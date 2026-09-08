import { createHash } from 'node:crypto';
/** Average number of group messages between two window anchors. */
const ANCHOR_STEP = 6;
function rowIdentity(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        return null;
    const record = raw;
    const value = record.message_id ?? record.seq;
    if (typeof value !== 'string' && typeof value !== 'number')
        return null;
    const identity = String(value).slice(0, 128);
    return identity === '' ? null : identity;
}
/**
 * Whether a group message may start the context window.
 *
 * Derived from the message's own identity, so the same message is an anchor in
 * every request that carries it, in any process, with no stored state. A message
 * the host reports without an identity can never anchor a window.
 */
export function isGroupContextWindowAnchor(raw) {
    const identity = rowIdentity(raw);
    if (identity === null)
        return false;
    const digest = createHash('sha256')
        .update('groupmate.group-context.window-anchor.v1 ')
        .update(identity)
        .digest();
    return digest[0] % ANCHOR_STEP === 0;
}
/**
 * Where the group context window starts, so consecutive turns only append to it.
 *
 * The host serves group history as "the newest N messages", so keeping a fixed
 * count drops the oldest message every time a new one arrives and rewrites the
 * whole block. That block is the largest part of a group prompt and it sits ahead
 * of memory, the session metadata and the current request, so a provider that
 * only credits a byte-identical prefix charges all of it as a miss on every
 * single turn.
 *
 * Pinning the start to a message instead of to an offset fixes that: among the
 * positions that still leave `minimumItems` messages, the newest anchor wins, and
 * it keeps winning while it stays inside the fetched history — so a later turn is
 * the earlier prompt plus whatever arrived since. The anchor moves once every
 * `ANCHOR_STEP` messages on average and only that turn pays for a rewritten
 * window, which is also the only reason the window holds between `minimumItems`
 * and `rows.length` messages rather than exactly `minimumItems`.
 *
 * `rows` must be ordered oldest first, as the host returns it.
 */
export function stableGroupContextWindowStart(rows, minimumItems) {
    const overshoot = Math.max(0, rows.length - Math.max(1, Math.trunc(minimumItems) || 1));
    for (let index = overshoot; index >= 0; index -= 1) {
        if (isGroupContextWindowAnchor(rows[index]))
            return index;
    }
    return overshoot;
}
export function stableGroupContextWindow(rows, minimumItems) {
    return rows.slice(stableGroupContextWindowStart(rows, minimumItems));
}
