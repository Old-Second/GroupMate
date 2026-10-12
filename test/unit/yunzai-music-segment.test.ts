import assert from 'node:assert/strict'
import { test } from 'node:test'
import { materializeYunzaiMusicSegment } from '../../src/runtime/presentation/yunzai-music-segment.js'

test('OICQ without a music factory emits a standard OneBot music segment', () => {
  assert.deepEqual(materializeYunzaiMusicSegment({}, '163', '123'), { type: 'music', data: { type: '163', id: '123' } })
})

test('a supplied music factory retains its receiver and normal arguments', () => {
  const segment = { music (provider: string, id: string) { assert.equal(this, segment); return { provider, id } } }
  assert.deepEqual(materializeYunzaiMusicSegment(segment, '163', '123'), { provider: '163', id: '123' })
})

test('invalid music identifiers cannot materialize host messages', () => {
  assert.throws(() => materializeYunzaiMusicSegment({}, '163', 'https://private.example'))
  assert.throws(() => materializeYunzaiMusicSegment({}, 'custom' as never, '123'))
})
