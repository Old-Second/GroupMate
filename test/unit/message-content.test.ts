import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeMessageContent } from '../../src/runtime/message-content.js'

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
