import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const root = process.cwd()

const removedRuntimeFiles = [
  'client/ChatGLM4Client.js',
  'client/ClaudeAPIClient.js',
  'client/CopilotAIClient.js',
  'client/CustomGoogleGeminiClient.js',
  'client/GoogleGeminiClient.js',
  'utils/SydneyAIClient.js',
  'utils/chatglm.js',
  'utils/message.js',
  'utils/alibaba/qwen-api.js',
  'utils/alibaba/tokenizer.js',
  'utils/alibaba/types.js',
  'utils/claude.ai/index.js',
  'utils/xinghuo/xinghuo.js'
]

async function readSource (file: string): Promise<string> {
  return await readFile(path.join(root, file), 'utf8')
}

test('core runtime contains only the OpenAI-compatible provider path', async () => {
  const source = await readSource('model/core.js')
  const removedMarkers = [
    'OfficialChatGPTClient',
    'SydneyAIClient',
    'ClaudeAPIClient',
    'ClaudeAIClient',
    'XinghuoClient',
    'CustomGoogleGeminiClient',
    'ChatGLM4Client',
    'QwenApi',
    "use === 'bing'",
    "use === 'api3'",
    "use === 'claude'",
    "use === 'claude2'",
    "use === 'xh'",
    "use === 'azure'",
    "use === 'qwen'",
    "use === 'gemini'",
    "use === 'chatglm4'"
  ]

  for (const marker of removedMarkers) {
    assert.equal(source.includes(marker), false, `${marker} must be removed from model/core.js`)
  }

  for (const marker of ['ChatGPTAPI', 'executeLegacyToolCall', 'shouldFinalizeAfterTool']) {
    assert.equal(source.includes(marker), true, `${marker} must remain in model/core.js`)
  }
})

test('chat and conversation entry points no longer expose provider-specific runtime branches', async () => {
  const chat = await readSource('apps/chat.js')
  const conversation = await readSource('src/runtime/conversation-manager.ts')

  for (const marker of [
    "fnc: 'chatglm'",
    "fnc: 'bing'",
    "fnc: 'claude'",
    "fnc: 'claude2'",
    "fnc: 'qwen'",
    "fnc: 'gemini'",
    "fnc: 'xh'",
    'newxhBotConversation',
    'searchxhBot'
  ]) {
    assert.equal(chat.includes(marker), false, `${marker} must be removed from apps/chat.js`)
  }

  for (const marker of [
    'CHATGPT:CONVERSATIONS_BING:',
    'CHATGPT:CONVERSATIONS_CLAUDE:',
    'CHATGPT:CONVERSATIONS_XH:',
    'CHATGPT:CONVERSATIONS_QWEN:',
    'CHATGPT:CONVERSATIONS_GEMINI:',
    'CHATGPT:CONVERSATIONS_CHATGLM4:',
    'CHATGPT:QQ_CONVERSATION:'
  ]) {
    assert.equal(conversation.includes(marker), false, `${marker} must not be read, scanned or deleted`)
  }
  assert.equal(conversation.includes('CHATGPT:CONVERSATIONS:'), false)
})

test('provider-specific runtime files are deleted', async () => {
  for (const file of removedRuntimeFiles) {
    let error: NodeJS.ErrnoException | undefined
    try {
      await access(path.join(root, file))
    } catch (caught) {
      error = caught as NodeJS.ErrnoException
    }
    assert.equal(error?.code, 'ENOENT', `${file} must be deleted`)
  }
})
