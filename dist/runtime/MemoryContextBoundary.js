import { AgentError } from '../agent/contracts/error.js';
import { parseContextDependencyProof } from '../agent/context/ContextDependency.js';
export function changedContextError() {
    return new AgentError({ code: 'authorization_changed', stage: 'run.context_authority', retryable: false,
        userMessage: '当前资料或权限已发生变化，请重新提问。' });
}
export async function captureMemoryContextProof(initial, authority, signal, inherited) {
    const refs = [...(inherited?.memories ?? []), ...initial.map(item => item.memoryRecord)];
    if (refs.some(ref => ref === undefined))
        throw changedContextError();
    const unique = new Map();
    for (const ref of refs) {
        const key = `${ref.namespaceRef}\0${ref.memoryId}`;
        const previous = unique.get(key);
        if (previous !== undefined && previous.revisionHash !== ref.revisionHash)
            throw changedContextError();
        unique.set(key, ref);
    }
    const memories = [...unique.values()];
    const authorityStamp = memories.length === 0 ? null : await authority?.(memories, signal);
    if (memories.length > 0 && authorityStamp == null)
        throw changedContextError();
    return parseContextDependencyProof({ schemaVersion: 1, memories, authorityStamp });
}
export function provenMemoryContextBoundary(proof, authority) {
    return async (_boundary, signal) => {
        if (signal.aborted)
            throw new DOMException('operation was aborted', 'AbortError');
        if (proof.memories.length === 0)
            return;
        let stamp;
        try {
            stamp = await authority?.(proof.memories, signal);
        }
        catch {
            throw changedContextError();
        }
        if (stamp == null || stamp !== proof.authorityStamp)
            throw changedContextError();
    };
}
/** Keep all original dependencies: dropping a prompt block cannot untaint earlier model/tool output. */
export function memoryContextBoundary(initial, reload) {
    const dependencies = initial.map(item => item.memoryRecord);
    return async (_boundary, signal) => {
        if (signal.aborted)
            throw new DOMException('operation was aborted', 'AbortError');
        if (dependencies.length === 0)
            return;
        let current;
        try {
            current = await reload(signal);
        }
        catch {
            if (signal.aborted)
                throw new DOMException('operation was aborted', 'AbortError');
            throw changedContextError();
        }
        if (dependencies.some(dependency => dependency === undefined || !current.some(item => {
            const record = item.memoryRecord;
            return record !== undefined && record.namespaceRef === dependency.namespaceRef &&
                record.memoryId === dependency.memoryId && record.revision === dependency.revision &&
                record.revisionHash === dependency.revisionHash;
        })))
            throw changedContextError();
    };
}
