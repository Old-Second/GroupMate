import { randomUUID } from 'node:crypto'

export interface VitsGenerateRequest {
  data: unknown[]
  fn_index: 0
  session_hash: string
}

export function buildVitsGenerateRequest (data: unknown[]): VitsGenerateRequest {
  return {
    data,
    fn_index: 0,
    session_hash: randomUUID().replaceAll('-', '')
  }
}
