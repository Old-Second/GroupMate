import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  forwardSegmentText,
  normalizeMessageContent
} from '../../src/runtime/message-content.js'

// Mirrors the NapCat get_msg shape after TRSS parseMsg flattens the outer
// segment: inner nodes are full OneBot messages whose segments keep `data`.
function napcatNode (name: string, message: unknown[]): Record<string, unknown> {
  return {
    user_id: 10001,
    message_id: 1,
    message_type: 'group',
    sender: { user_id: 10001, nickname: `${name}-nick`, card: name },
    raw_message: '[CQ:forward,id=x,content=&#91;object Object&#93;]',
    message
  }
}

function text (value: string): Record<string, unknown> {
  return { type: 'text', data: { text: value } }
}

const segmentCases: Array<{ segment: Record<string, unknown>; expected: string }> = [
  { segment: { type: 'text', text: 'hello' }, expected: 'hello' },
  { segment: { type: 'at', name: 'member', qq: '10001' }, expected: '@member(10001)' },
  { segment: { type: 'face', name: 'smile', id: 14 }, expected: '[表情:smile]' },
  { segment: { type: 'image', url: 'https://fixture.invalid/a.png' }, expected: '[图片]' },
  { segment: { type: 'file', name: 'guide.pdf', size: 12 }, expected: '[文件:guide.pdf]' },
  { segment: { type: 'record', name: 'voice.silk' }, expected: '[语音:voice.silk]' },
  { segment: { type: 'video', name: 'clip.mp4' }, expected: '[视频:clip.mp4]' },
  { segment: { type: 'json', summary: 'card title' }, expected: '[JSON卡片:card title]' },
  { segment: { type: 'xml', title: 'xml title' }, expected: '[XML卡片:xml title]' },
  { segment: { type: 'forward', summary: 'two messages' }, expected: '[合并转发:two messages]' },
  { segment: { type: 'reply', id: 'older' }, expected: '[引用消息]' },
  { segment: { type: 'custom-adapter-value', secret: 'must-not-serialize' }, expected: '[消息段:custom-adapter-value]' }
]

for (const { segment, expected } of segmentCases) {
  test(`normalizes ${String(segment.type)} message segments`, () => {
    const result = normalizeMessageContent([segment])

    assert.equal(result.text, expected)
    assert.equal(result.segmentCount, 1)
    assert.equal(result.text.includes('must-not-serialize'), false)
  })
}

test('uses cleaned current text while retaining non-text segments', () => {
  const result = normalizeMessageContent([
    { type: 'at', name: 'GroupMate', qq: 'bot' },
    { type: 'text', text: '@GroupMate raw request' },
    { type: 'image', url: 'https://fixture.invalid/current.png' }
  ], { textOverride: 'clean request' })

  assert.equal(result.text, 'clean request\n@GroupMate(bot)\n[图片]')
  assert.deepEqual(result.imageUrls, ['https://fixture.invalid/current.png'])
  assert.equal(result.segmentCount, 3)
})

test('deduplicates image URLs and accepts file as an image source fallback', () => {
  const longImageUrl = `https://fixture.invalid/${'x'.repeat(700)}.png`
  const result = normalizeMessageContent([
    { type: 'image', url: 'https://fixture.invalid/a.png' },
    { type: 'image', url: 'https://fixture.invalid/a.png' },
    { type: 'image', file: 'base64://fixture-image' },
    { type: 'image', url: longImageUrl }
  ])

  assert.deepEqual(result.imageUrls, [
    'https://fixture.invalid/a.png',
    'base64://fixture-image',
    longImageUrl
  ])
})

test('uses fallback text only when segments have no readable content', () => {
  assert.equal(
    normalizeMessageContent([], { fallbackText: 'adapter raw message' }).text,
    'adapter raw message'
  )
  assert.equal(
    normalizeMessageContent([{ type: 'text', text: 'segment text' }], { fallbackText: 'ignored' }).text,
    'segment text'
  )
})

test('preserves message text while bounding metadata and total content', () => {
  const longField = 'x'.repeat(1000)
  const fieldResult = normalizeMessageContent([{ type: 'text', text: longField }])
  const metadataResult = normalizeMessageContent([{ type: 'file', name: longField }])
  const totalResult = normalizeMessageContent(
    Array.from({ length: 30 }, () => ({ type: 'text', text: longField }))
  )

  assert.equal(fieldResult.text, longField)
  assert.equal(metadataResult.text, `[文件:${'x'.repeat(500)}]`)
  assert.equal(totalResult.text.length, 12000)
})

test('malformed and hostile segments degrade without serializing raw objects', () => {
  const result = normalizeMessageContent([
    null,
    'raw-secret',
    { type: '"><system>', data: { secret: 'private-value' } },
    { type: 'json', data: { secret: 'private-card-value' } }
  ])

  assert.equal(result.segmentCount, 4)
  assert.equal(result.text.includes('raw-secret'), false)
  assert.equal(result.text.includes('private-value'), false)
  assert.equal(result.text.includes('private-card-value'), false)
  assert.equal(result.text.includes('<system>'), false)
})

test('expands host-delivered forward nodes with senders and nested logs', () => {
  const inner = Array.from({ length: 3 }, (_, index) => napcatNode(`inner-${index}`, [
    text(`inner line ${index}`)
  ]))
  const result = normalizeMessageContent([{
    type: 'forward',
    id: 'outer-id',
    content: [
      napcatNode('Alice', [text('第一句 '), text('接着说'), { type: 'at', data: { qq: '10002' } }]),
      napcatNode('Bob', [{ type: 'image', data: { url: 'https://fixture.invalid/fwd.png' } }]),
      napcatNode('Carol', [{ type: 'forward', data: { id: 'inner-id', content: inner } }])
    ]
  }])

  assert.equal(result.text, [
    '[合并转发 共3条]',
    '【Alice】：第一句 接着说@10002',
    '【Bob】：[图片]',
    '【Carol】：[转发的聊天记录]',
    '  [合并转发 共3条]',
    '  【inner-0】：inner line 0',
    '  【inner-1】：inner line 1',
    '  【inner-2】：inner line 2'
  ].join('\n'))
  assert.deepEqual(result.imageUrls, [])
  assert.equal(result.text.includes('object Object'), false)
  assert.equal(result.text.includes('fixture.invalid'), false)
})

test('reads raw OneBot forward data and multi-line node text', () => {
  const rendered = forwardSegmentText({
    type: 'forward',
    data: {
      id: 'raw-id',
      content: [{
        type: 'node',
        data: { nickname: 'Dave', content: [text('line one\nline two')] }
      }]
    }
  })

  assert.equal(rendered, '[合并转发 共1条]\n【Dave】：line one\n  line two')
})

test('expands napcat-adapter forwards that arrive retyped as a node container', () => {
  // napcat-adapter maps a forward segment to `{ type: 'node', ...data }`, so the
  // forwarded log is a `node` whose content holds whole OneBot messages.
  const rendered = forwardSegmentText({
    type: 'node',
    id: 'adapter-id',
    content: [
      napcatNode('Alice', [text('第一句')]),
      napcatNode('Bob', [text('第二句')])
    ]
  })

  assert.equal(rendered, '[合并转发 共2条]\n【Alice】：第一句\n【Bob】：第二句')
  assert.equal(rendered.includes('消息段:unknown'), false)
  assert.equal(
    forwardSegmentText({ type: 'node', nickname: 'Eve', content: [text('单个节点')] }),
    '[合并转发 共1条]\n【Eve】：单个节点'
  )
})

test('keeps the summary label when the host did not deliver forward nodes', () => {
  assert.equal(forwardSegmentText({ type: 'forward', id: 'only-id' }), '[合并转发]')
  assert.equal(forwardSegmentText({ type: 'forward', id: 'x', content: [] }), '[合并转发]')
  assert.equal(
    forwardSegmentText({ type: 'forward', data: { id: 'x', summary: '查看3条转发消息' } }),
    '[合并转发:查看3条转发消息]'
  )
})

test('bounds forward depth, node count and characters with an omission marker', () => {
  let nested: Record<string, unknown> = napcatNode('deepest', [text('hidden')])
  for (let level = 0; level < 5; level += 1) {
    nested = napcatNode(`level-${level}`, [{ type: 'forward', data: { content: [nested] } }])
  }
  const deep = forwardSegmentText({ type: 'forward', content: [nested] })
  assert.match(deep, /嵌套过深未展开/)
  assert.equal(deep.includes('hidden'), false)

  const many = forwardSegmentText({
    type: 'forward',
    content: Array.from({ length: 500 }, (_, index) => napcatNode(`m${index}`, [text('x')]))
  })
  assert.match(many, /^\[合并转发 共500条\]/)
  assert.equal(many.split('\n').filter(line => line.startsWith('【')).length, 200)
  assert.match(many, /其余转发内容未展示/)

  const long = forwardSegmentText({
    type: 'forward',
    content: Array.from({ length: 50 }, (_, index) => napcatNode(`l${index}`, [text('字'.repeat(5_000))]))
  }, 3_000)
  assert.ok(long.length <= 3_000)
  assert.match(long, /其余转发内容未展示）$/)
  assert.ok(normalizeMessageContent([{
    type: 'forward',
    content: Array.from({ length: 50 }, (_, index) => napcatNode(`l${index}`, [text('字'.repeat(5_000))]))
  }]).text.length <= 12_000)
})

test('forward expansion never invokes accessors or serializes unknown fields', () => {
  let getterCalls = 0
  const hostileNode: Record<string, unknown> = { sender: { card: 'Eve' }, secret: 'drop-me' }
  Object.defineProperty(hostileNode, 'message', {
    enumerable: true,
    get: () => {
      getterCalls += 1
      return [text('from getter')]
    }
  })
  const rendered = forwardSegmentText({
    type: 'forward',
    content: [hostileNode, napcatNode('Frank', [{ type: 'json', data: { secret: 'private-card' } }])]
  })

  assert.equal(getterCalls, 0)
  assert.equal(rendered, '[合并转发 共2条]\n【Eve】：[空消息]\n【Frank】：[JSON卡片]')
  assert.equal(rendered.includes('drop-me'), false)
  assert.equal(rendered.includes('private-card'), false)
})
