import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SessionAddress } from '../../src/agent/contracts/identity.js'
import { presentPictureReply } from '../../src/runtime/picture-reply.js'
import type { GroupMatePictureRenderer } from '../../src/runtime/presentation/groupmate-picture-renderer.js'
import type {
  OutboundDeliveryOptions,
  OutboundPart,
  YunzaiOutboundPort,
  YunzaiOutboundPortFactory
} from '../../src/runtime/presentation/yunzai-outbound-port.js'

const target: SessionAddress = Object.freeze({
  botId: 'bot-1', scope: Object.freeze({ kind: 'group', groupId: 'group-1' })
})
const resource = Object.freeze({
  kind: 'buffer' as const,
  data: new Uint8Array([137, 80, 78, 71]),
  mimeType: 'image/png',
  byteLength: 4
})
const settings = Object.freeze({
  userEnabled: true,
  autoEnabled: true,
  autoThreshold: 1,
  deviceScaleFactor: 1,
  closeBrowserAfterRender: true,
  showQRCode: true,
  live2d: null
})

function input () {
  return Object.freeze({
    text: '最终安全正文',
    target,
    citations: Object.freeze([{ title: '来源', text: '引用' }]),
    reasoningView: Object.freeze({ text: '推理', truncated: false }),
    settings,
    quoteMessageId: 'request-1'
  })
}

function fixture (deliveries: Array<'sent' | 'rejected' | 'unknown'>, render = true) {
  const parts: OutboundPart[] = []
  const attempts: number[] = []
  const options: Array<OutboundDeliveryOptions | undefined> = []
  const renders: unknown[] = []
  const renderer: GroupMatePictureRenderer = {
    render: async value => {
      renders.push(value)
      return render
        ? { kind: 'rendered', resource, source: 'local' }
        : { kind: 'not_rendered', code: 'render_failed' }
    }
  }
  const port: YunzaiOutboundPort = {
    target,
    deliver: async (part, attempt, deliveryOptions) => {
      parts.push(part)
      attempts.push(attempt)
      options.push(deliveryOptions)
      const next = deliveries.shift() ?? 'sent'
      if (next === 'rejected') {
        return { kind: 'failed_definite', media: part.media, attempt, code: 'host_rejected' } as never
      }
      if (next === 'unknown') {
        return { kind: 'outcome_unknown', media: part.media, attempt, code: 'unknown_host_result' } as never
      }
      return {
        kind: 'sent', media: part.media, attempt,
        receipt: { schemaVersion: 1, media: part.media, messageId: `${part.media}-${parts.length}` }
      } as never
    },
    recall: async () => ({ kind: 'recalled' })
  }
  const outboundFactory: YunzaiOutboundPortFactory = { forTarget: async () => port }
  return { renderer, outboundFactory, parts, attempts, options, renders }
}

test('picture reply succeeds without text fallback', async () => {
  const f = fixture(['sent'])
  const result = await presentPictureReply(input(), {
    renderer: f.renderer,
    outboundFactory: f.outboundFactory
  })
  assert.equal(result.outcome, 'complete')
  assert.deepEqual(f.parts.map(part => part.media), ['picture'])
  assert.equal(f.options[0]?.quoteMessageId, 'request-1')
  assert.equal(f.renders.length, 1)
})

test('picture render failure restores citation text and reasoning once', async () => {
  const f = fixture(['sent', 'sent', 'sent'], false)
  const result = await presentPictureReply(input(), {
    renderer: f.renderer,
    outboundFactory: f.outboundFactory
  })
  assert.equal(result.outcome, 'complete')
  assert.deepEqual(f.parts.map(part => part.media), ['forward', 'text', 'forward'])
  assert.equal(f.parts.filter(part => part.media === 'text').length, 1)
})

test('definite picture rejection retries the same part then falls back once', async () => {
  const f = fixture(['rejected', 'rejected', 'sent', 'sent', 'sent'])
  const result = await presentPictureReply(input(), {
    renderer: f.renderer,
    outboundFactory: f.outboundFactory
  })
  assert.equal(result.outcome, 'partial')
  assert.deepEqual(f.parts.map(part => part.media), ['picture', 'picture', 'forward', 'text', 'forward'])
  assert.strictEqual(f.parts[0], f.parts[1])
  assert.deepEqual(f.attempts.slice(0, 2), [1, 2])
  assert.equal(f.parts.filter(part => part.media === 'text').length, 1)
})

test('picture unknown delivery never sends fallback text', async () => {
  const f = fixture(['unknown'])
  const result = await presentPictureReply(input(), {
    renderer: f.renderer,
    outboundFactory: f.outboundFactory
  })
  assert.equal(result.outcome, 'unknown')
  assert.deepEqual(f.parts.map(part => part.media), ['picture'])
})
