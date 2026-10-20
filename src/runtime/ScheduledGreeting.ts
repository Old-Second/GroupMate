import { createHostRecordPart } from './presentation/yunzai-outbound-port.js'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getProductionYunzaiAgent } from './production-yunzai-agent.js'
import { currentGroupMember } from './CurrentGroupMember.js'
import { plainTextPart } from './presentation/text-presentation.js'
import type { OutboundPart } from './presentation/yunzai-outbound-port.js'
import type { ProactiveLease } from './participation/ProactiveCoordination.js'

interface GreetingPorts {
  readonly claim?: (bot: Record<string, any>, groupId: number) => Promise<ProactiveLease | null>
  readonly groups: readonly string[]
  readonly probability: number
  readonly bots: readonly Record<string, any>[]
  readonly random?: () => number
  readonly generate: (bot: Record<string, any>, groupId: number) => Promise<string>
  readonly render: (text: string) => Promise<unknown>
  readonly send: (bot: Record<string, any>, groupId: number, message: unknown, current?: () => boolean) => Promise<unknown>
}

// The cron is a host callback. Overlapping callbacks do not double-generate or double-send a scope.
const active = new Set<string>()
export async function runScheduledGreetings (ports: GreetingPorts): Promise<boolean> {
  const random = ports.random ?? Math.random
  const seen = new Set<string>()
  for (const rawGroup of ports.groups.slice(0, 64)) {
    if (!rawGroup) continue
    const groupId = Number.parseInt(rawGroup, 10)
    if (!Number.isSafeInteger(groupId) || groupId <= 0) continue
    for (const bot of ports.bots.slice(0, 16)) {
      const key = JSON.stringify([String(bot.uin ?? bot.self_id ?? ''), groupId])
      if (seen.has(key) || active.has(key) || active.size >= 64) continue
      seen.add(key)
      if (!bot.gl?.get(groupId) || Math.floor(random() * 100) >= ports.probability) continue
      active.add(key)
      let lease: ProactiveLease | null | undefined
      let sent = false
      try {
        lease = await ports.claim?.(bot, groupId)
        if (ports.claim !== undefined && lease === null) continue
        const message = await ports.generate(bot, groupId)
        const rendered = await ports.render(message)
        if (rendered === null) return false
        if (lease !== undefined && !lease!.current()) continue
        sent = Boolean(await ports.send(bot, groupId, rendered, lease?.current))
      } finally { await lease?.finish(sent); active.delete(key) }
    }
  }
  return true
}

/** Legacy TTS returns a record segment; project only its media resource into the shared outbound port. */
export async function sendScheduledGroupMessage (bot: Record<string, any>, groupId: number, message: unknown, current?: () => boolean): Promise<unknown> {
  const agent = getProductionYunzaiAgent()
  const botId = String(bot.uin ?? bot.self_id ?? '')
  const signal = AbortSignal.timeout(30_000)
  if (await currentGroupMember(bot, String(groupId), botId, signal) === null) return false
  let part: OutboundPart
  if (typeof message === 'string') part = plainTextPart(message)
  else {
    const record = message as Record<string, any> | null
    if (record?.type !== 'record') throw new TypeError('scheduled greeting media is invalid')
    const file = record.file ?? record.data?.file
    if (typeof file === 'string' && file.startsWith('protobuf://')) part = createHostRecordPart(file)
    else if (typeof file === 'string' && file.startsWith('base64://')) {
      if (file.length > 6 * 1024 * 1024) throw new TypeError('scheduled audio exceeds limit')
      const data = Buffer.from(file.slice(9), 'base64')
      part = { media: 'voice', resource: { kind: 'buffer', data, byteLength: data.byteLength, mimeType: 'audio/ogg' } }
    } else if (typeof file === 'string' && /^https?:\/\//.test(file)) {
      part = { media: 'voice', resource: { kind: 'remote_url', url: file, byteLength: 0, mimeType: 'audio/ogg' } }
    } else if (typeof file === 'string') {
      const path = file.startsWith('file:') ? fileURLToPath(file) : file
      part = { media: 'voice', resource: { kind: 'local_path', path, byteLength: statSync(path).size, mimeType: 'audio/ogg' } }
    } else if (file instanceof Uint8Array) part = { media: 'voice', resource: { kind: 'buffer', data: file, byteLength: file.byteLength, mimeType: 'audio/ogg' } }
    else throw new TypeError('scheduled greeting resource is invalid')
  }
  const port = await agent.outboundFactory.forTarget({ botId, scope: { kind: 'group', groupId: String(groupId) } })
  if (current !== undefined && !current()) return false
  const delivery = await port.deliver(part, 1, { signal })
  return delivery.kind === 'sent' ? delivery.receipt : delivery.kind === 'outcome_unknown' ? { kind: 'outcome_unknown' } : false
}
