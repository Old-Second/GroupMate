import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('legacy chat skips audio generation when VITS falls back to text', async () => {
  const source = await readFile(new URL('../../apps/chat.js', import.meta.url), 'utf8')

  assert.match(
    source,
    /import\s*\{[\s\S]{0,120}shouldFallbackVitsToText,[\s\S]{0,120}shouldSendTtsText[\s\S]{0,120}\}\s*from '\.\.\/dist\/runtime\/tts-presentation\.js'/
  )
  assert.match(source, /const ttsTextFallback = shouldFallbackVitsToText\(\{/)
  assert.match(source, /const sendTtsText = shouldSendTtsText\(\{/)
  assert.match(source, /if \(sendTtsText\)/)
  assert.match(source, /if \(ttsTextFallback\) \{[\s\S]{0,160}回复的内容过长，已转为文本模式/)
  assert.match(
    source,
    /if \(!ttsTextFallback\) \{[\s\S]{0,240}const sendable = await generateAudio\(this\.e, ttsResponse, emotion, emotionDegree\)/
  )
  assert.equal(
    source.match(/const sendable = await generateAudio\(this\.e, ttsResponse, emotion, emotionDegree\)/g)?.length,
    1
  )
})
