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
