import type { ToolTarget } from '../../agent/tools/tool-context.js'

export interface ProgressOutputRequest {
  readonly text: string
  readonly target: ToolTarget
  readonly runId: string
  readonly callId: string
  readonly snapshotId: string
  readonly signal: AbortSignal
}

export type ProgressDelivery =
  | { readonly kind: 'sent'; readonly sequence: number }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'suppressed' }
  | { readonly kind: 'invalid' }

export interface ProgressOutputAuditEvent {
  readonly event: 'groupmate.progress.output'
  readonly runIdHash: string
  readonly callIdHash: string
  readonly snapshotIdHash: string
  readonly sequence: number | null
  readonly outcome: 'sent' | 'duplicate' | 'suppressed' | 'invalid' | 'indeterminate'
  readonly characters: number
  readonly bytes: number
}

export interface ProgressOutputControllerOptions {
  readonly maxMessages: number
  readonly maxCharacters: number
  readonly hash: (value: string) => string
  readonly send: (text: string, target: ToolTarget, signal: AbortSignal) => Promise<void>
  readonly audit: (event: ProgressOutputAuditEvent) => Promise<void>
}

function delivery (kind: Exclude<ProgressDelivery['kind'], 'sent'>): ProgressDelivery {
  return Object.freeze({ kind })
}

export class ProgressOutputController {
  readonly #maxMessages: number
  readonly #maxCharacters: number
  readonly #hash: ProgressOutputControllerOptions['hash']
  readonly #send: ProgressOutputControllerOptions['send']
  readonly #audit: ProgressOutputControllerOptions['audit']
  readonly #reservedTexts = new Map<string, number>()
  #attempts = 0

  constructor (options: ProgressOutputControllerOptions) {
    if (!Number.isSafeInteger(options.maxMessages) || options.maxMessages <= 0 ||
      !Number.isSafeInteger(options.maxCharacters) || options.maxCharacters <= 0) {
      throw new TypeError('progress output limits are invalid')
    }
    this.#maxMessages = options.maxMessages
    this.#maxCharacters = options.maxCharacters
    this.#hash = options.hash
    this.#send = options.send
    this.#audit = options.audit
  }

  #event (
    request: ProgressOutputRequest,
    outcome: ProgressOutputAuditEvent['outcome'],
    sequence: number | null,
    characters: number,
    bytes: number
  ): ProgressOutputAuditEvent {
    return Object.freeze({
      event: 'groupmate.progress.output',
      runIdHash: this.#hash(request.runId),
      callIdHash: this.#hash(request.callId),
      snapshotIdHash: this.#hash(request.snapshotId),
      sequence,
      outcome,
      characters,
      bytes
    })
  }

  async deliver (request: ProgressOutputRequest): Promise<ProgressDelivery> {
    const normalized = request.text.trim().normalize('NFC')
    const characters = [...normalized].length
    const bytes = Buffer.byteLength(normalized, 'utf8')
    if (normalized === '' || characters > this.#maxCharacters) {
      await this.#audit(this.#event(request, 'invalid', null, characters, bytes))
      return delivery('invalid')
    }
    const duplicateSequence = this.#reservedTexts.get(normalized)
    if (duplicateSequence !== undefined) {
      await this.#audit(this.#event(request, 'duplicate', duplicateSequence, characters, bytes))
      return delivery('duplicate')
    }
    if (this.#attempts >= this.#maxMessages) {
      await this.#audit(this.#event(request, 'suppressed', null, characters, bytes))
      return delivery('suppressed')
    }

    this.#attempts += 1
    const sequence = this.#attempts
    this.#reservedTexts.set(normalized, sequence)
    try {
      await this.#send(normalized, request.target, request.signal)
      await this.#audit(this.#event(request, 'sent', sequence, characters, bytes))
      return Object.freeze({ kind: 'sent', sequence })
    } catch (error) {
      try {
        await this.#audit(this.#event(request, 'indeterminate', sequence, characters, bytes))
      } catch {}
      throw error
    }
  }
}
