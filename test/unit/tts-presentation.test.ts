import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  shouldFallbackVitsToText,
  shouldSendTtsText
} from '../../src/runtime/tts-presentation.js'

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
