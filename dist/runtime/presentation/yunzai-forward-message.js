export async function materializeYunzaiForwardMessage(target, part) {
    const nodes = [
        { message: part.title },
        ...part.nodes.map(node => ({ message: node.text }))
    ];
    const makeForwardMsg = Reflect.get(target, 'makeForwardMsg', target);
    if (typeof makeForwardMsg === 'function') {
        return await Reflect.apply(makeForwardMsg, target, [nodes]);
    }
    return { type: 'node', data: nodes };
}
