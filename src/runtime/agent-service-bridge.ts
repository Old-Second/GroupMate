import type {
  RunApprovalDecisionCommand,
  RunApprovalDisplayCommand,
  RunControlOptions
} from '../agent/run/run-engine.js'
import type { ApprovalInterruption } from '../agent/run/interruption.js'
import {
  AgentService,
  type ChatReplyEnvelope,
  type ConversationSessionPort
} from './agent-service.js'
import type { YunzaiAgentRequest } from './yunzai-request-adapter.js'

export class AgentServiceBridge {
  readonly #service: AgentService

  constructor (service: AgentService) {
    this.#service = service
  }

  get conversations (): ConversationSessionPort {
    return this.#service.conversations
  }

  async handle (
    request: YunzaiAgentRequest,
    options: RunControlOptions = {}
  ): Promise<ChatReplyEnvelope> {
    return await this.#service.handle(request, options)
  }

  async handleEphemeral (
    request: YunzaiAgentRequest,
    options: RunControlOptions = {}
  ): Promise<ChatReplyEnvelope> {
    return await this.#service.handleEphemeral(request, options)
  }

  async resume (
    runId: string,
    options: RunControlOptions = {}
  ): Promise<ChatReplyEnvelope> {
    return await this.#service.resume(runId, options)
  }

  async pendingApproval (
    runId: string,
    approvalId: string
  ): Promise<ApprovalInterruption | null> {
    return await this.#service.pendingApproval(runId, approvalId)
  }

  async displayApproval (
    input: RunApprovalDisplayCommand
  ): Promise<ApprovalInterruption | null> {
    return await this.#service.displayApproval(input)
  }

  async decideApproval (
    input: RunApprovalDecisionCommand,
    options: RunControlOptions = {}
  ): Promise<ChatReplyEnvelope | null> {
    return await this.#service.decideApproval(input, options)
  }
}

let processSingleton: AgentServiceBridge | undefined

export function getAgentServiceBridge (
  createService: () => AgentService
): AgentServiceBridge {
  if (processSingleton === undefined) {
    processSingleton = new AgentServiceBridge(createService())
  }
  return processSingleton
}
