import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  preprocessTtsText,
  shouldFallbackVitsToText,
  shouldSendTtsText
} from '../../src/runtime/tts-presentation.js'

test('TTS preprocessing preserves regex emoji punctuation and Azure emotion behavior', async () => {
  const processed = preprocessTtsText({
    text: '  [cheerful, 3.5] 保留DROP🙂-:_；*;e\u0301 [sad, 0]  ',
    mode: 'azure',
    filter: Object.freeze({ source: 'DROP', flags: 'gi' }),
    azureEmotionEnabled: true
  })
  assert.deepEqual(processed, {
    bodyText: '保留DROP🙂-:_；*;é',
    spokenText: '保留，，，，，，é',
    emotion: 'cheerful',
    emotionDegree: 2
  })

  assert.deepEqual(preprocessTtsText({
    text: '  普通🙂\n文本  ',
    mode: 'voicevox',
    filter: null,
    azureEmotionEnabled: true
  }), {
    bodyText: '普通🙂\n文本',
    spokenText: '普通，文本'
  })

  assert.deepEqual(preprocessTtsText({
    text: '[cheerful, 1.5] 正文 [sad, 1]',
    mode: 'azure',
    filter: Object.freeze({ source: 'cheerful', flags: 'g' }),
    azureEmotionEnabled: true
  }), {
    bodyText: '正文',
    spokenText: '正文',
    emotion: 'cheerful',
    emotionDegree: 1.5
  })
})

test('falls back to text when a VITS reply exceeds the configured threshold', () => {
  assert.equal(shouldFallbackVitsToText({
    ttsMode: 'vits-uma-genshin-honkai',
    textCharacters: 300,
    threshold: '299'
  }), true)
})

test('keeps VITS audio when the reply is exactly at the threshold', () => {
  assert.equal(shouldFallbackVitsToText({
    ttsMode: 'vits-uma-genshin-honkai',
    textCharacters: 299,
    threshold: 299
  }), false)
})

test('does not apply the VITS threshold to other modes or invalid thresholds', () => {
  assert.equal(shouldFallbackVitsToText({
    ttsMode: 'azure',
    textCharacters: 300,
    threshold: 299
  }), false)
  assert.equal(shouldFallbackVitsToText({
    ttsMode: 'vits-uma-genshin-honkai',
    textCharacters: 300,
    threshold: 'invalid'
  }), false)
})

test('preserves text copies for long non-VITS replies', () => {
  assert.equal(shouldSendTtsText({
    alsoSendText: false,
    textCharacters: 300,
    threshold: 299
  }), true)
  assert.equal(shouldSendTtsText({
    alsoSendText: false,
    textCharacters: 299,
    threshold: 299
  }), false)
  assert.equal(shouldSendTtsText({
    alsoSendText: true,
    textCharacters: 1,
    threshold: 299
  }), true)
})
