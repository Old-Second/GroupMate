import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('legacy VITS generation delegates Gradio request metadata to TypeScript', async () => {
  const source = await readFile(new URL('../../utils/tts.js', import.meta.url), 'utf8')

  assert.match(
    source,
    /import\s*\{\s*buildVitsGenerateRequest\s*\}\s*from '\.\.\/dist\/runtime\/vits-gradio\.js'/
  )
  assert.match(
    source,
    /body: JSON\.stringify\(buildVitsGenerateRequest\(body\.data\)\)/
  )
  assert.doesNotMatch(source, /body: JSON\.stringify\(body\)/)
})

test('lower-level TTS adapters keep audio bounded abortable and free of content logs', async () => {
  const [vits, voicevox, azure, upload, index] = await Promise.all([
    readFile(new URL('../../utils/tts.js', import.meta.url), 'utf8'),
    readFile(new URL('../../utils/tts/voicevox.js', import.meta.url), 'utf8'),
    readFile(new URL('../../utils/tts/microsoft-azure.js', import.meta.url), 'utf8'),
    readFile(new URL('../../utils/uploadRecord.js', import.meta.url), 'utf8'),
    readFile(new URL('../../index.js', import.meta.url), 'utf8')
  ])

  assert.match(vits, /MAX_VITS_RESPONSE_BYTES/)
  assert.match(vits, /signal/)
  assert.match(voicevox, /MAX_VOICEVOX_AUDIO_BYTES/)
  assert.match(voicevox, /readBoundedBytes/)
  assert.match(azure, /signal/)
  assert.match(azure, /completed[\s\S]*unlink/)
  assert.match(upload, /MAX_AUDIO_BYTES/)
  assert.match(upload, /readBoundedBytes/)
  assert.match(upload, /combinedSignal/)
  assert.match(upload, /execFile\(/)
  assert.match(upload, /finally[\s\S]*unlink/)
  assert.match(index, /runLowMemoryTts/)
  assert.match(index, /MAX_AUDIO_BYTES/)

  for (const source of [vits, voicevox, upload, index]) {
    assert.doesNotMatch(source, /response\.(?:arrayBuffer|blob|text)\(\)/)
  }
  assert.doesNotMatch(vits, /logger\.(?:info|warn|error)\([^\n]*(?:text|url|responseBody)/)
  assert.doesNotMatch(voicevox, /logger\.(?:info|warn|error)\([^\n]*text/)
  assert.doesNotMatch(upload, /logger\.(?:info|warn|error)\([^\n]*(?:recordUrl|result\.error|err\b|\bt\b)/)
})
