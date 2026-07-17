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
  const [randomMessage, legacyChat, translation, auxiliaryCompletion, index] = await Promise.all([
    readSource('utils/randomMessage.js'),
    readSource('utils/chat.js'),
    readSource('src/runtime/translation-service.ts'),
    readSource('src/runtime/auxiliary-completion-service.ts'),
    readSource('index.js')
  ])

  assert.match(bym, /dist\/runtime\/production-yunzai-agent\.js/)
  assert.match(bym, /bymController\.bym\(event\)/)
  assert.doesNotMatch(bym, /model\/core\.js|core\.sendMessage/)
  assert.doesNotMatch(bym, /bymMode|\b(?:bing|claude2?|gemini|qwen|chatglm4?|xh):\s*system/)

  for (const source of [randomMessage, legacyChat]) {
    assert.match(source, /dist\/runtime\/auxiliary-completion-service\.js/)
    assert.doesNotMatch(source, /completion-facade|ChatGPTAPI|chat\/completions/)
  }
  assert.doesNotMatch(
    [translation, auxiliaryCompletion].join('\n'),
    /completion-facade|OpenAICompatibleAdapter|chat\/completions/
  )
  assert.equal((index.match(/new OpenAICompatibleAdapter\(/g) ?? []).length, 1)
  assert.match(index, /configureAuxiliaryCompletionService\([\s\S]*?adapter:\s*modelPort/)
  assert.match(index, /configureTranslationService\([\s\S]*?adapter:\s*modelPort/)
  assert.doesNotMatch(
    [randomMessage, legacyChat, translation, auxiliaryCompletion].join('\n'),
    /translateSource|CustomGoogleGeminiClient|XinghuoClient|QwenApi|gpt-3\.5-turbo/
  )
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
