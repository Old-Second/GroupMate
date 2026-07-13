import { readChatErrorMetadata } from './chat-error-presentation.js'

export type ProviderRequestAttemptKind = 'primary' | 'recovery'

export interface ProviderRequestRecoveryOptions<T> {
  readonly canRecover: boolean
  readonly attempt: (kind: ProviderRequestAttemptKind) => Promise<T>
  readonly onRecovery?: () => void
}

export async function withInvalidFormatRecovery<T> (
  options: ProviderRequestRecoveryOptions<T>
): Promise<T> {
  try {
    return await options.attempt('primary')
  } catch (error) {
    if (!options.canRecover || readChatErrorMetadata(error).statusCode !== 400) {
      throw error
    }
    options.onRecovery?.()
    return await options.attempt('recovery')
  }
}
