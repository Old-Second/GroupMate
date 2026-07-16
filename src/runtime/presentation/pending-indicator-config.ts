export const PENDING_INDICATOR_REDIS_KEY = 'CHATGPT:CONFIRM'

export interface PendingIndicatorConfigPort {
  getEnabled(): Promise<boolean>
  setEnabled(enabled: boolean): Promise<void>
}

interface PendingIndicatorRedisPort {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<unknown>
}

export function createPendingIndicatorConfigPort (
  redis: PendingIndicatorRedisPort
): PendingIndicatorConfigPort {
  return Object.freeze({
    async getEnabled (): Promise<boolean> {
      const value = await redis.get(PENDING_INDICATOR_REDIS_KEY)
      return value === null || value === 'on'
    },
    async setEnabled (enabled: boolean): Promise<void> {
      if (typeof enabled !== 'boolean') {
        throw new TypeError('pending indicator setting is invalid')
      }
      await redis.set(PENDING_INDICATOR_REDIS_KEY, enabled ? 'on' : 'off')
    }
  })
}
