export interface RedisToolClient {
  get(key: string): Promise<string | null>
  getDel(key: string): Promise<string | null>
  set(
    key: string,
    value: string,
    options: { EX: number; NX?: boolean; XX?: boolean }
  ): Promise<unknown>
  del(key: string): Promise<number>
}
