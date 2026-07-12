import { AgentError } from '../contracts/error.js';
const optionalPriority = {
    system_instruction: 0,
    runtime_fact: 5,
    session_history: 3,
    group_context: 2,
    memory: 1,
    current_request: 0,
    tool_chain: 4
};
function contextError(stage, details) {
    return new AgentError({
        code: 'context_budget_exceeded',
        stage,
        retryable: false,
        userMessage: '当前请求超出可用上下文范围，请缩短内容后重试。',
        details
    });
}
function cancelledError() {
    return new AgentError({
        code: 'cancelled',
        stage: 'context.prepare',
        retryable: false,
        userMessage: '操作已取消。'
    });
}
function assertNotAborted(signal) {
    if (signal?.aborted === true)
        throw cancelledError();
}
function safeInteger(value, label, positive) {
    if (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) {
        throw new TypeError(`${label} must be a ${positive ? 'positive' : 'non-negative'} safe integer`);
    }
    return value;
}
function availableTokens(budget) {
    const model = safeInteger(budget.modelContextTokens, 'model context tokens', true);
    const output = safeInteger(budget.reservedOutputTokens, 'reserved output tokens', false);
    const tools = safeInteger(budget.reservedToolTokens, 'reserved tool tokens', false);
    const safety = safeInteger(budget.safetyMarginTokens, 'safety margin tokens', false);
    safeInteger(budget.maxItems, 'maximum context items', true);
    safeInteger(budget.maxBytes, 'maximum context bytes', true);
    const available = model - output - tools - safety;
    if (available <= 0) {
        throw contextError('context.budget', {
            modelContextTokens: model,
            reservedTokens: output + tools + safety
        });
    }
    return available;
}
function sourceIsMandatory(source) {
    return source === 'system_instruction' || source === 'current_request';
}
function byteLength(items) {
    try {
        const modelInput = items.map(item => ({
            id: item.id,
            source: item.source,
            atomicGroupId: item.atomicGroupId,
            role: item.message.role,
            parts: item.message.parts
        }));
        return Buffer.byteLength(JSON.stringify(modelInput), 'utf8');
    }
    catch (error) {
        throw new AgentError({
            code: 'invalid_request',
            stage: 'context.input',
            retryable: false,
            userMessage: '上下文输入格式无效。',
            cause: error
        });
    }
}
function buildGroups(items) {
    const grouped = new Map();
    for (const estimated of items) {
        const groupId = estimated.item.atomicGroupId ?? `item:${estimated.item.id}`;
        const group = grouped.get(groupId);
        if (group === undefined)
            grouped.set(groupId, [estimated]);
        else
            group.push(estimated);
    }
    return [...grouped.entries()].map(([id, groupItems]) => ({
        id,
        items: groupItems,
        tokens: groupItems.reduce((total, value) => total + value.tokens, 0),
        mandatory: groupItems.some(value => sourceIsMandatory(value.item.source)),
        priority: Math.max(...groupItems.map(value => optionalPriority[value.item.source])),
        newestAt: groupItems.reduce((latest, value) => {
            return value.item.message.createdAt > latest ? value.item.message.createdAt : latest;
        }, ''),
        tieBreakId: [...groupItems].map(value => value.item.id).sort()[0] ?? id
    }));
}
function optionalGroupOrder(left, right) {
    if (left.priority !== right.priority)
        return right.priority - left.priority;
    const newest = right.newestAt.localeCompare(left.newestAt);
    if (newest !== 0)
        return newest;
    return left.tieBreakId.localeCompare(right.tieBreakId);
}
export class ContextEngine {
    estimator;
    memoryStore;
    constructor(options) {
        this.estimator = options.estimator;
        this.memoryStore = options.memoryStore;
    }
    async prepare(input, budget, signal) {
        assertNotAborted(signal);
        const availableInputTokens = availableTokens(budget);
        const memories = input.memoryQuery === undefined
            ? []
            : await this.memoryStore.retrieve(input.memoryQuery, signal);
        assertNotAborted(signal);
        const memoryItems = memories.map(candidate => ({
            id: `memory:${candidate.memoryId}`,
            source: 'memory',
            message: candidate.message
        }));
        const semanticItems = [
            ...input.systemInstructions,
            ...input.runtimeFacts,
            ...input.sessionHistory,
            ...input.groupContext,
            ...memoryItems,
            input.currentRequest,
            ...input.toolMessages
        ];
        if (semanticItems.length > budget.maxItems) {
            throw contextError('context.input', {
                itemCount: semanticItems.length,
                maxItems: budget.maxItems
            });
        }
        const inputBytes = byteLength(semanticItems);
        if (inputBytes > budget.maxBytes) {
            throw contextError('context.input', { inputBytes, maxBytes: budget.maxBytes });
        }
        const seen = new Set();
        const unique = [];
        const duplicates = [];
        for (const [semanticIndex, item] of semanticItems.entries()) {
            if (seen.has(item.id)) {
                duplicates.push(Object.freeze({ id: item.id, reason: 'duplicate' }));
            }
            else {
                seen.add(item.id);
                unique.push({ item, semanticIndex });
            }
        }
        const estimated = unique.map(value => {
            const tokens = this.estimator.estimate(value.item.message);
            if (!Number.isSafeInteger(tokens) || tokens < 0) {
                throw new TypeError('token estimator must return a non-negative safe integer');
            }
            return { ...value, tokens };
        });
        const groups = buildGroups(estimated);
        const mandatoryGroups = groups.filter(group => group.mandatory);
        const mandatoryTokens = mandatoryGroups.reduce((total, group) => total + group.tokens, 0);
        if (mandatoryTokens > availableInputTokens) {
            throw contextError('context.mandatory', {
                availableInputTokens,
                mandatoryTokens,
                mandatoryItems: mandatoryGroups.reduce((total, group) => total + group.items.length, 0)
            });
        }
        const selectedGroups = new Set(mandatoryGroups.map(group => group.id));
        let estimatedInputTokens = mandatoryTokens;
        for (const group of groups.filter(group => !group.mandatory).sort(optionalGroupOrder)) {
            if (estimatedInputTokens + group.tokens <= availableInputTokens) {
                selectedGroups.add(group.id);
                estimatedInputTokens += group.tokens;
            }
        }
        const selectedIds = new Set();
        for (const group of groups) {
            if (!selectedGroups.has(group.id))
                continue;
            for (const value of group.items)
                selectedIds.add(value.item.id);
        }
        const items = Object.freeze(estimated
            .filter(value => selectedIds.has(value.item.id))
            .sort((left, right) => left.semanticIndex - right.semanticIndex)
            .map(value => value.item));
        const budgetOmissions = estimated
            .filter(value => !selectedIds.has(value.item.id))
            .sort((left, right) => left.semanticIndex - right.semanticIndex)
            .map(value => Object.freeze({ id: value.item.id, reason: 'budget' }));
        const omitted = Object.freeze([...duplicates, ...budgetOmissions]);
        const includedIds = Object.freeze(items.map(item => item.id));
        return Object.freeze({
            items,
            estimatedInputTokens,
            availableInputTokens,
            includedIds,
            omitted
        });
    }
}
