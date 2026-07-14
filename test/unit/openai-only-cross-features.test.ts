import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const root = process.cwd()

async function readSource (file: string): Promise<string> {
  return await readFile(path.join(root, file), 'utf8')
}

test('BYM and auxiliary callers use only the configured OpenAI-compatible API', async () => {
  const bym = await readSource('apps/bym.js')
  const auxiliary = await Promise.all([
    readSource('utils/randomMessage.js'),
    readSource('utils/translate.js'),
    readSource('utils/chat.js')
  ])

  assert.match(bym, /dist\/runtime\/agent-service-bridge\.js/)
  assert.match(bym, /handleEphemeral\(e,\s*trigger\.prompt,/)
  assert.match(bym, /systemInstructions:\s*\[system\]/)
  assert.doesNotMatch(bym, /model\/core\.js|core\.sendMessage/)
  assert.doesNotMatch(bym, /bymMode|\b(?:bing|claude2?|gemini|qwen|chatglm4?|xh):\s*system/)

  for (const source of auxiliary) {
    assert.match(source, /dist\/runtime\/completion-facade\.js/)
    assert.doesNotMatch(source, /ChatGPTAPI|chat\/completions/)
  }
  assert.doesNotMatch(auxiliary.join('\n'), /translateSource|CustomGoogleGeminiClient|XinghuoClient|QwenApi|gpt-3\.5-turbo/)
})

test('prompt, history, buttons and entertainment expose no removed provider path', async () => {
  const sources = await Promise.all([
    readSource('apps/prompts.js'),
    readSource('apps/history.js'),
    readSource('apps/button.js'),
    readSource('apps/entertainment.js'),
    readSource('utils/randomMessage.js')
  ])
  const combined = sources.join('\n')

  assert.doesNotMatch(
    combined,
    /api3|Copilot|Sydney|Claude(?:\.ai)?|Gemini|通义千问|讯飞星火|ChatGLM|Config\.(?:sydney|claude\w*|gemini\w*|qwen\w*|xh\w*|chatglm\w*|translateSource)/i
  )

  const entertainment = sources[3]
  for (const marker of ["fnc: 'translate'", "fnc: 'ocr'", "fnc: 'screenshotUrl'", "fnc: 'wordcloud'"]) {
    assert.equal(entertainment.includes(marker), true, `${marker} must remain`)
  }
  assert.doesNotMatch(entertainment, /translateSource|\bVQA\b|图片识别|识图/i)
})

test('legacy image generation runtime is deleted', async () => {
  for (const file of ['apps/draw.js', 'utils/BingDraw.js', 'utils/dalle.js']) {
    let error: NodeJS.ErrnoException | undefined
    try {
      await access(path.join(root, file))
    } catch (caught) {
      error = caught as NodeJS.ErrnoException
    }
    assert.equal(error?.code, 'ENOENT', `${file} must be deleted`)
  }
})
