import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  buildLegacyQuoteForwardMessages,
  buildLegacyThinkingForwardMessages,
  presentLegacyReply,
  selectLegacyPresentationMode
} from '../../model/legacy/reply-presenter.js'
import { createLegacyYunzaiFake } from '../helpers/legacy-yunzai-fake.js'

function extractObjectCallOptions (source, marker) {
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `missing ${marker}`)
  const openBrace = start + marker.length - 1
  let depth = 0
  for (let index = openBrace; index < source.length; index++) {
    if (source[index] === '{') depth++
    if (source[index] === '}') depth--
    if (depth === 0) return source.slice(openBrace + 1, index)
  }
  assert.fail(`unterminated ${marker}`)
}

test('legacy reasoning forwards explicit segments before parsed thinking blocks', () => {
  assert.deepEqual(buildLegacyThinkingForwardMessages('', []), [])
  assert.deepEqual(
    buildLegacyThinkingForwardMessages('ignored', [' first ', '', 'second']),
    ['first', 'second']
  )
  assert.deepEqual(
    buildLegacyThinkingForwardMessages('【模型思考】\nfixture one\n\n【工具调用：weather】\nfixture two'),
    ['【模型思考】\nfixture one', '【工具调用：weather】\nfixture two']
  )
})

test('legacy quote forwards omit blank text and retain text-url formatting', () => {
  assert.deepEqual(buildLegacyQuoteForwardMessages([
    { text: 'fixture source', url: 'https://fixture.invalid/source' },
    { text: '   ', url: 'https://fixture.invalid/ignored' }
  ]), ['fixture source - https://fixture.invalid/source'])
})

test('legacy presentation mode keeps TTS then picture then text priority', () => {
  assert.equal(selectLegacyPresentationMode({ useTTS: true, forcePictureMode: true }), 'tts')
  assert.equal(selectLegacyPresentationMode({ forcePictureMode: true }), 'picture')
  assert.equal(selectLegacyPresentationMode({ userPictureMode: true }), 'picture')
  assert.equal(selectLegacyPresentationMode({
    autoPicture: true,
    responseLength: 1201,
    autoPictureThreshold: 1200
  }), 'picture')
  assert.equal(selectLegacyPresentationMode({
    autoPicture: true,
    responseLength: 1200,
    autoPictureThreshold: 1200
  }), 'text')
})

test('legacy group reply mutates array payload with markdown buttons and recalls bot message first', async () => {
  const { calls, event, handler, logger, plugin } = createLegacyYunzaiFake()
  const message = ['fixture response']
  const data = { recallMsg: 3, marker: 'fixture' }

  const result = await presentLegacyReply({
    event,
    message,
    quote: true,
    data,
    markdownEnabled: true,
    handler,
    logger,
    schedule: plugin.schedule
  })

  assert.deepEqual(result, { message_id: 'fixture-bot-message' })
  assert.strictEqual(calls.replies[0].message, message)
  assert.deepEqual(calls.replies[0], {
    message: ['fixture response', { type: 'button', content: [{ text: 'fixture button' }] }],
    quote: true,
    data: { recallMsg: 0, marker: 'fixture' }
  })
  assert.deepEqual(calls.handler, [{
    name: 'chatgpt.button.post',
    eventId: 'fixture-event',
    data
  }])
  assert.deepEqual(data, { recallMsg: 3, marker: 'fixture' })
  assert.equal(calls.schedules[0].delay, 3000)
  calls.schedules[0].callback()
  assert.deepEqual(calls.groupRecalls, ['fixture-bot-message'])
  assert.deepEqual(calls.friendRecalls, [])
})

test('legacy markdown-disabled reply bypasses the button handler', async () => {
  const { calls, event, handler, logger, plugin } = createLegacyYunzaiFake()

  await presentLegacyReply({
    event,
    message: 'fixture response',
    quote: false,
    data: { marker: 'fixture' },
    markdownEnabled: false,
    handler,
    logger,
    schedule: plugin.schedule
  })

  assert.deepEqual(calls.handler, [])
  assert.deepEqual(calls.replies, [{
    message: 'fixture response',
    quote: false,
    data: { marker: 'fixture', recallMsg: 0 }
  }])
  assert.deepEqual(calls.schedules, [])
})

test('legacy private reply schedules friend recall when no group exists', async () => {
  const { calls, event, handler, logger, plugin } = createLegacyYunzaiFake({ isGroup: false })

  await presentLegacyReply({
    event,
    message: 'fixture private response',
    quote: true,
    data: { recallMsg: 2 },
    markdownEnabled: false,
    handler,
    logger,
    schedule: plugin.schedule
  })

  assert.equal(calls.schedules[0].delay, 2000)
  calls.schedules[0].callback()
  assert.deepEqual(calls.groupRecalls, [])
  assert.deepEqual(calls.friendRecalls, ['fixture-bot-message'])
})

test('chat app delegates only the characterized presenter decisions to the legacy seam', async () => {
  const source = await readFile(new URL('../../apps/chat.js', import.meta.url), 'utf8')
  const presenterImport = source.match(
    /import\s*\{(?<names>[^}]*)\}\s*from '\.\.\/model\/legacy\/reply-presenter\.js'/
  )

  assert.ok(presenterImport)
  for (const name of [
    'buildLegacyQuoteForwardMessages',
    'buildLegacyThinkingForwardMessages',
    'presentLegacyReply',
    'selectLegacyPresentationMode'
  ]) {
    assert.match(presenterImport.groups.names, new RegExp(`\\b${name}\\b`))
  }
  assert.equal(source.match(/\bpresentLegacyReply\(\{/g)?.length ?? 0, 1)
  const presenterOptions = extractObjectCallOptions(source, 'presentLegacyReply({')
  assert.match(presenterOptions, /event:\s*e/)
  assert.match(presenterOptions, /message:\s*msg/)
  assert.match(presenterOptions, /quote,/)
  assert.match(presenterOptions, /data,/)
  assert.match(presenterOptions, /markdownEnabled:\s*Config\.enableMd/)
  assert.match(presenterOptions, /handler:\s*e\.runtime\?\.handler\s*\|\|\s*\{\}/)
  assert.match(presenterOptions, /logger,/)
  assert.match(presenterOptions, /schedule:\s*setTimeout/)
  assert.equal(source.match(/\bconst presentationMode\s*=\s*selectLegacyPresentationMode\(\{/g)?.length ?? 0, 1)
  const modeOptions = extractObjectCallOptions(source, 'selectLegacyPresentationMode({')
  assert.match(modeOptions, /useTTS,/)
  assert.match(modeOptions, /forcePictureMode,/)
  assert.match(modeOptions, /userPictureMode:\s*userSetting\.usePicture/)
  assert.match(modeOptions, /autoPicture:\s*Config\.autoUsePicture/)
  assert.match(modeOptions, /responseLength:\s*response\.length/)
  assert.match(modeOptions, /autoPictureThreshold:\s*Config\.autoUsePictureThreshold/)
  assert.equal(source.match(/presentationMode\s*===\s*'tts'/g)?.length ?? 0, 1)
  assert.equal(source.match(/presentationMode\s*===\s*'picture'/g)?.length ?? 0, 1)
  assert.equal(source.match(/buildLegacyQuoteForwardMessages\(quotemessage\)/g)?.length ?? 0, 2)
  assert.equal(
    source.match(/buildLegacyThinkingForwardMessages\(thinking, thinkingSegments\)/g)?.length ?? 0,
    1
  )
  assert.doesNotMatch(source, /\breplyWithoutRecallingUserMessage\b/)
  assert.doesNotMatch(source, /\bbuildThinkingForwardMessages\b/)
})
