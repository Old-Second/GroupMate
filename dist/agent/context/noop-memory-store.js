import { AgentError } from '../contracts/error.js';
const emptyMemories = Object.freeze([]);
export class NoopMemoryStore {
    async retrieve(_query, signal) {
        if (signal?.aborted === true) {
            throw new AgentError({
                code: 'cancelled',
                stage: 'memory.retrieve',
                retryable: false,
                userMessage: '操作已取消。'
            });
        }
        return emptyMemories;
    }
}
