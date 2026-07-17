import type {
  OwnerDiagnosticResponse,
  OwnerDiagnostics
} from './observability/owner-diagnostics.js'

export interface DiagnosticYunzaiEvent {
  readonly authorized: boolean
  readonly commandArgument: string
  readonly replyText: (text: string) => Promise<void>
}

interface OwnerDiagnosticsPort {
  status(input: { readonly authorized: boolean }): Promise<OwnerDiagnosticResponse>
  inspect(input: {
    readonly authorized: boolean
    readonly runRef: string
  }): Promise<OwnerDiagnosticResponse>
}

export class YunzaiDiagnosticsController {
  readonly #diagnostics: Pick<OwnerDiagnostics, 'status' | 'inspect'> | OwnerDiagnosticsPort

  constructor (diagnostics: Pick<OwnerDiagnostics, 'status' | 'inspect'> | OwnerDiagnosticsPort) {
    this.#diagnostics = diagnostics
  }

  async handleStatus (event: DiagnosticYunzaiEvent): Promise<boolean> {
    const result = await this.#diagnostics.status({ authorized: event.authorized })
    await event.replyText(result.text)
    return true
  }

  async handleInspect (event: DiagnosticYunzaiEvent): Promise<boolean> {
    const result = await this.#diagnostics.inspect({
      authorized: event.authorized,
      runRef: event.commandArgument
    })
    await event.replyText(result.text)
    return true
  }
}
