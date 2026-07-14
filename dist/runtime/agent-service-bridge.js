export class AgentServiceBridge {
    #service;
    constructor(service) {
        this.#service = service;
    }
    get conversations() {
        return this.#service.conversations;
    }
    async handle(request, options = {}) {
        return await this.#service.handle(request, options);
    }
    async handleEphemeral(request, options = {}) {
        return await this.#service.handleEphemeral(request, options);
    }
    async resume(runId, options = {}) {
        return await this.#service.resume(runId, options);
    }
    async pendingApproval(runId, approvalId) {
        return await this.#service.pendingApproval(runId, approvalId);
    }
    async displayApproval(input) {
        return await this.#service.displayApproval(input);
    }
    async decideApproval(input, options = {}) {
        return await this.#service.decideApproval(input, options);
    }
}
let processSingleton;
export function getAgentServiceBridge(createService) {
    if (processSingleton === undefined) {
        processSingleton = new AgentServiceBridge(createService());
    }
    return processSingleton;
}
