import { ToolInputError, validateToolDefinition } from './schema-validator.js';
import { actorMaySendCrossChannel } from './cross-channel-access.js';
const snapshotIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const groupPermissions = new Set([
    'self_member', 'group_moderator', 'group_owner_or_master', 'bot_group_owner'
]);
export class ToolRegistryError extends TypeError {
    code;
    constructor(code) {
        super(code === 'invalid_registry' ? 'tool registry is invalid' : 'tool snapshot is invalid');
        this.name = 'ToolRegistryError';
        this.code = code;
    }
}
export class ToolUnavailableError extends Error {
    code;
    constructor() {
        super('tool is unavailable in this snapshot');
        this.name = 'ToolUnavailableError';
        this.code = 'tool_unavailable';
    }
}
function cloneSchema(schema) {
    if ('anyOf' in schema) {
        return Object.freeze({
            anyOf: Object.freeze(schema.anyOf.map(cloneSchema))
        });
    }
    if (schema.type === 'object') {
        const properties = Object.create(null);
        for (const name of Object.keys(schema.properties).sort()) {
            properties[name] = cloneSchema(schema.properties[name]);
        }
        return Object.freeze({
            type: 'object',
            properties: Object.freeze(properties),
            required: Object.freeze([...schema.required]),
            additionalProperties: false
        });
    }
    if (schema.type === 'array') {
        return Object.freeze({ type: 'array', items: cloneSchema(schema.items) });
    }
    if ('enum' in schema && schema.enum !== undefined) {
        if (schema.type === 'string')
            return Object.freeze({ type: 'string', enum: Object.freeze([...schema.enum]) });
        if (schema.type === 'boolean')
            return Object.freeze({ type: 'boolean', enum: Object.freeze([...schema.enum]) });
        return Object.freeze({ type: schema.type, enum: Object.freeze([...schema.enum]) });
    }
    return Object.freeze({ type: schema.type });
}
function cloneDefinition(source) {
    const definition = {
        name: source.name,
        version: 1,
        aliases: Object.freeze([...source.aliases]),
        description: source.description,
        inputSchema: cloneSchema(source.inputSchema),
        effect: source.effect,
        risk: source.risk,
        readOnly: source.readOnly,
        destructive: source.destructive,
        idempotency: source.idempotency,
        openWorld: source.openWorld,
        timeoutMs: source.timeoutMs,
        maxOutputBytes: source.maxOutputBytes,
        network: source.network,
        permission: source.permission,
        ...(source.crossChannelAccess === undefined
            ? {}
            : { crossChannelAccess: Object.freeze({ ...source.crossChannelAccess }) }),
        resolveTarget: source.resolveTarget,
        execute: source.execute
    };
    return Object.freeze(definition);
}
function visibleInScene(definition, facts) {
    if (groupPermissions.has(definition.permission) && facts.channel.kind !== 'group')
        return false;
    if (definition.permission === 'cross_channel') {
        const access = definition.crossChannelAccess;
        return access !== undefined && (actorMaySendCrossChannel(access, 'private', facts.actor.isBotMaster) ||
            actorMaySendCrossChannel(access, 'group', facts.actor.isBotMaster));
    }
    return true;
}
function modelDefinition(definition) {
    return Object.freeze({
        type: 'function',
        function: Object.freeze({
            name: definition.name,
            description: definition.description,
            parameters: definition.inputSchema
        })
    });
}
export class ToolRegistry {
    #definitions;
    #canonical;
    constructor(definitions) {
        const names = new Map();
        const canonical = new Map();
        try {
            for (const source of definitions) {
                validateToolDefinition(source);
                const definition = cloneDefinition(source);
                const registered = Object.freeze({ definition, canonicalName: definition.name });
                for (const name of [definition.name, ...definition.aliases]) {
                    if (names.has(name))
                        throw new ToolRegistryError('invalid_registry');
                    names.set(name, registered);
                }
                canonical.set(definition.name, registered);
            }
        }
        catch (error) {
            if (error instanceof ToolRegistryError)
                throw error;
            if (error instanceof ToolInputError)
                throw new ToolRegistryError('invalid_registry');
            throw error;
        }
        this.#definitions = names;
        this.#canonical = canonical;
    }
    createSnapshot(input) {
        if (!snapshotIdPattern.test(input.id) || !Array.isArray(input.enabledTools)) {
            throw new ToolRegistryError('invalid_snapshot');
        }
        const selected = new Map();
        for (const name of input.enabledTools) {
            const registered = this.#canonical.get(name);
            if (registered === undefined)
                throw new ToolRegistryError('invalid_snapshot');
            if (visibleInScene(registered.definition, input.facts))
                selected.set(name, registered);
        }
        const registeredTools = [...selected.values()]
            .sort((left, right) => left.canonicalName.localeCompare(right.canonicalName, 'en'));
        const visibleNames = new Map();
        for (const registered of registeredTools) {
            visibleNames.set(registered.definition.name, registered);
            for (const alias of registered.definition.aliases)
                visibleNames.set(alias, registered);
        }
        const id = input.id;
        const toolNames = Object.freeze(registeredTools.map(tool => tool.canonicalName));
        const modelTools = Object.freeze(registeredTools.map(tool => modelDefinition(tool.definition)));
        return Object.freeze({
            id,
            toolNames,
            modelTools,
            resolve(requestedName) {
                const registered = visibleNames.get(requestedName);
                if (registered === undefined)
                    throw new ToolUnavailableError();
                return registered;
            },
            resolveCall(call) {
                if (call.snapshotId !== id)
                    throw new ToolUnavailableError();
                const registered = visibleNames.get(call.requestedName);
                if (registered === undefined)
                    throw new ToolUnavailableError();
                return registered;
            }
        });
    }
}
