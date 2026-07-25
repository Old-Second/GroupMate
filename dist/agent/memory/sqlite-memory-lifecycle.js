import { types as utilTypes } from 'node:util';
import { decodeMemoryLifecycleCommandWireV1, parseMemoryLifecycleCommandV1 } from './memory-lifecycle-command.js';
import { invalidMemoryValue } from './memory-namespace.js';
import { createSqliteMemoryLifecycleMutationAdapterV1 } from './sqlite-memory-lifecycle-mutation.js';
import { createSqliteMemoryLifecycleProposalAdapterV1 } from './sqlite-memory-lifecycle-proposal.js';
export function createSqliteMemoryLifecycleAdapterV1(options) {
    if (options === null || typeof options !== 'object' || utilTypes.isProxy(options) ||
        options.database === null || typeof options.database !== 'object' ||
        utilTypes.isProxy(options.database) || typeof options.now !== 'function' ||
        utilTypes.isProxy(options.now))
        return invalidMemoryValue();
    const direct = createSqliteMemoryLifecycleProposalAdapterV1(options);
    const mutation = createSqliteMemoryLifecycleMutationAdapterV1(options);
    return Object.freeze({
        execute: async (envelope, signal) => {
            const command = parseMemoryLifecycleCommandV1(envelope.command);
            const wire = decodeMemoryLifecycleCommandWireV1(command.wire);
            return wire.operation === 'proposal.createAndApprove'
                ? direct.execute(envelope, signal)
                : mutation.execute(envelope, signal);
        }
    });
}
