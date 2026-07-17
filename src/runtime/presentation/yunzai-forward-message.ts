import type { OutboundPart } from './yunzai-outbound-port.js'

type ForwardPart = Extract<OutboundPart, { media: 'forward' }>

interface YunzaiForwardTarget {
  readonly makeForwardMsg?: (nodes: readonly Readonly<{ message: string }>[]) => unknown
}

export async function materializeYunzaiForwardMessage (
  target: YunzaiForwardTarget,
  part: ForwardPart
): Promise<unknown> {
  const nodes = [
    { message: part.title },
    ...part.nodes.map(node => ({ message: node.text }))
  ]
  const makeForwardMsg = Reflect.get(target, 'makeForwardMsg', target)
  if (typeof makeForwardMsg === 'function') {
    return await Reflect.apply(makeForwardMsg, target, [nodes])
  }
  return { type: 'node', data: nodes }
}
