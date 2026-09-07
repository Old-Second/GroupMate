import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AgentContentPart, AgentMessage } from '../../src/agent/contracts/content.js'
import {
  agentMessageText,
  contentPartText,
  resourceReferenceLabel
} from '../../src/agent/contracts/content-projection.js'

const createdAt = '2026-07-13T00:00:00.000Z'

function message (id: string, parts: readonly AgentContentPart[]): AgentMessage {
  return Object.freeze({
    id,
    role: 'user' as const,
    parts: Object.freeze([...parts]),
    createdAt,
    provenance: Object.freeze({
      source: 'test',
      trust: 'untrusted' as const,
      sensitivity: 'group' as const,
      sourceId: id,
      createdAt
    })
  })
}

function image (resourceId: string): AgentContentPart {
  return Object.freeze({ type: 'resource_ref' as const, resourceType: 'image' as const, resourceId })
}

test('a resource label is a bounded lowercase hex token', () => {
  const label = resourceReferenceLabel('message-1', 0)

  assert.match(label, /^[0-9a-f]{12}$/)
  assert.equal(resourceReferenceLabel('message-1', 0), label)
})

test('a resource label ignores the locator entirely', () => {
  const signed = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=f&rkey=KEYONE00000'
  const rotated = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=f&rkey=KEYTWO11111'

  assert.equal(
    agentMessageText(message('message-1', [{ type: 'text', text: '看' }, image(signed)])),
    agentMessageText(message('message-1', [{ type: 'text', text: '看' }, image(rotated)]))
  )
})

test('resource labels separate positions and messages', () => {
  const labels = new Set([
    resourceReferenceLabel('message-1', 0),
    resourceReferenceLabel('message-1', 1),
    resourceReferenceLabel('message-2', 0),
    resourceReferenceLabel('message-2', 1)
  ])

  assert.equal(labels.size, 4)
})

test('a projected resource keeps its declared type and hides its locator', () => {
  const locator = 'https://cdn.example.test/photo.png?rkey=SECRET000'

  assert.equal(
    contentPartText(image(locator), 'message-1', 3),
    `[image: #${resourceReferenceLabel('message-1', 3)}]`
  )
  assert.equal(
    contentPartText(
      Object.freeze({ type: 'resource_ref', resourceType: 'file', resourceId: locator }),
      'message-1',
      3
    ),
    `[file: #${resourceReferenceLabel('message-1', 3)}]`
  )
})

test('non-resource parts project unchanged and an empty message stays marked', () => {
  const projected = agentMessageText(message('message-1', [
    { type: 'text', text: '前' },
    { type: 'mention', userId: 'user-1', displayName: '张三' },
    { type: 'tool_call', toolCallId: 'call-1', name: 'weather', arguments: Object.freeze({}) },
    { type: 'tool_result', toolCallId: 'call-1', status: 'ok', content: '晴' }
  ]))

  assert.equal(projected, '前\n@张三\n[工具调用: weather]\n[工具结果: ok] 晴')
  assert.equal(agentMessageText(message('message-1', [])), '[空消息]')
  assert.equal(agentMessageText(message('message-1', [{ type: 'text', text: '' }])), '[空消息]')
})
