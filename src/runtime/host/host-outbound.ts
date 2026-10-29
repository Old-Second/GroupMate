import type { ToolResource } from '../../tools/visible-tool-support.js'
import type { YunzaiBotPicker } from '../agent-service-bridge.js'
import type { SessionAddress } from '../../agent/contracts/identity.js'
import {
  buildChatButtonContent,
  type ButtonCompatibilityPort
} from '../yunzai-button-content.js'
import {
  materializeYunzaiForwardMessage,
  type YunzaiForwardTarget
} from '../presentation/yunzai-forward-message.js'
import {
  materializeYunzaiMagicSegment
} from '../presentation/yunzai-magic-segment.js'
import {
  materializeYunzaiMusicSegment
} from '../presentation/yunzai-music-segment.js'
import type {
  OutboundPart,
  SafeTextAtom,
  YunzaiHostTargetPort,
  YunzaiOutboundHostPort
} from '../presentation/yunzai-outbound-port.js'

// `globalThis.segment` is the host's own message-segment factory. Different Yunzai builds expose
// different subsets of it, so every call site checks for the method and falls back to the plain
// OneBot v11 object shape. The factory arrives as a reader, not a captured value: the host installs
// it during startup and the bootstrap may rebind it.
export interface HostOutboundDependencies {
  readonly segment: () => Readonly<Record<string, unknown>>
  readonly botPicker: YunzaiBotPicker
  readonly buttonPolicy: ButtonCompatibilityPort
}

export interface HostOutbound {
  resourceValue(resource: ToolResource): Buffer | string
  textAtomValue(atom: SafeTextAtom): unknown
  outboundMessage(receiver: unknown, part: OutboundPart): Promise<unknown>
  readonly outboundHost: YunzaiOutboundHostPort
}

function callable (segment: Readonly<Record<string, unknown>>, name: string): boolean {
  return typeof segment[name] === 'function'
}

function invoke (
  segment: Readonly<Record<string, unknown>>, name: string, args: readonly unknown[]
): unknown {
  return (segment[name] as (...values: readonly unknown[]) => unknown)(...args)
}

export function createHostOutbound (dependencies: HostOutboundDependencies): HostOutbound {
  const resourceValue = (resource: ToolResource): Buffer | string => {
    if (resource.kind === 'buffer') return Buffer.from(resource.data)
    if (resource.kind === 'remote_url') return resource.url
    return resource.path
  }

  const textAtomValue = (atom: SafeTextAtom): unknown => {
    const segment = dependencies.segment()
    if (atom.kind === 'text') return atom.text
    if (atom.kind === 'at') {
      const target = atom.target === 'all' ? 'all' : atom.target.userId
      return callable(segment, 'at')
        ? invoke(segment, 'at', [target])
        : { type: 'at', qq: target }
    }
    if (atom.kind === 'face') {
      return callable(segment, 'face')
        ? invoke(segment, 'face', [atom.faceId])
        : { type: 'face', id: atom.faceId }
    }
    return callable(segment, 'markdown')
      ? invoke(segment, 'markdown', [atom.markdown])
      : { type: 'markdown', data: { content: atom.markdown } }
  }

  const outboundMessage = async (receiver: unknown, part: OutboundPart): Promise<unknown> => {
    const segment = dependencies.segment()
    if (part.media === 'text') {
      const values: unknown[] = part.atoms.map(textAtomValue)
      const buttons = buildChatButtonContent(part.buttons, dependencies.buttonPolicy.snapshot())
      if (buttons !== null) values.push({ type: 'button', content: buttons })
      return values.length === 1 ? values[0] : values
    }
    if (part.media === 'picture') {
      return callable(segment, 'image')
        ? invoke(segment, 'image', [resourceValue(part.resource)])
        : { type: 'image', file: resourceValue(part.resource) }
    }
    if (part.media === 'voice') {
      return callable(segment, 'record')
        ? invoke(segment, 'record', [part.hostRecord ?? resourceValue(part.resource)])
        : { type: 'record', file: part.hostRecord ?? resourceValue(part.resource) }
    }
    if (part.media === 'video') {
      return callable(segment, 'video')
        ? invoke(segment, 'video', [resourceValue(part.resource)])
        : { type: 'video', file: resourceValue(part.resource) }
    }
    if (part.media === 'music') {
      return materializeYunzaiMusicSegment(segment, part.provider, part.id)
    }
    if (part.media === 'dice') return materializeYunzaiMagicSegment(segment, 'dice')
    if (part.media === 'rps') return materializeYunzaiMagicSegment(segment, 'rps', part.value)
    return await materializeYunzaiForwardMessage(receiver as YunzaiForwardTarget, part)
  }

  const outboundHost: YunzaiOutboundHostPort = Object.freeze({
    async forTarget (target: SessionAddress): Promise<YunzaiHostTargetPort | null> {
      const bot = await dependencies.botPicker.pick(target.botId)
      if (bot === null) return null
      const host = bot as Readonly<Record<string, unknown>>
      // A `group_user` scope carries both ids and the host picks its friend channel for it, so the
      // non-group branch reads `userId` off either remaining scope kind.
      const receiver = target.scope.kind === 'group'
        ? await (host.pickGroup as ((groupId: string) => unknown) | undefined)
          ?.call(host, target.scope.groupId)
        : await (host.pickFriend as ((userId: string) => unknown) | undefined)
          ?.call(host, target.scope.userId)
      if (receiver === null || typeof receiver !== 'object' ||
        typeof (receiver as Record<string, unknown>).sendMsg !== 'function') return null
      const sink = receiver as Record<string, unknown>
      return Object.freeze({
        async dispatch (
          part: OutboundPart, quoteMessageId: string | undefined, signal: AbortSignal | undefined
        ): Promise<unknown> {
          if (signal?.aborted === true) throw signal.reason
          const message = await outboundMessage(receiver, part)
          const send = sink.sendMsg as (value: unknown) => unknown
          if (quoteMessageId === undefined) return await send.call(sink, message)
          const segment = dependencies.segment()
          const reply = callable(segment, 'reply')
            ? invoke(segment, 'reply', [quoteMessageId])
            : { type: 'reply', id: quoteMessageId }
          const quoted = Array.isArray(message) ? [reply, ...message] : [reply, message]
          return await send.call(sink, quoted)
        },
        async recall (messageId: string | number, signal?: AbortSignal): Promise<unknown> {
          if (signal?.aborted === true) throw signal.reason
          const recallMsg = sink.recallMsg
          return typeof recallMsg === 'function'
            ? await (recallMsg as (value: unknown) => unknown).call(sink, messageId)
            : false
        }
      })
    }
  })

  return Object.freeze({ resourceValue, textAtomValue, outboundMessage, outboundHost })
}
