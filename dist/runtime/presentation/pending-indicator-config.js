export const PENDING_INDICATOR_REDIS_KEY = 'CHATGPT:CONFIRM';
export function createPendingIndicatorConfigPort(redis) {
    return Object.freeze({
        async getEnabled() {
            const value = await redis.get(PENDING_INDICATOR_REDIS_KEY);
            return value === null || value === 'on';
        },
        async setEnabled(enabled) {
            if (typeof enabled !== 'boolean') {
                throw new TypeError('pending indicator setting is invalid');
            }
            await redis.set(PENDING_INDICATOR_REDIS_KEY, enabled ? 'on' : 'off');
        }
    });
}
