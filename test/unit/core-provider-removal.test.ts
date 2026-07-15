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

const retiredPhaseFiveRuntimeFiles = [
  'model/core.js',
  'utils/openai/chatgpt-api.js',
  'utils/openai/fetch-sse.js',
  'utils/openai/stream-async-iterable.js',
  'utils/openai/tokenizer.js',
  'utils/openai/types.js',
  'src/runtime/provider-request-recovery.ts',
  'dist/runtime/provider-request-recovery.js',
  'src/runtime/legacy-session-bridge.ts',
  'dist/runtime/legacy-session-bridge.js',
  'src/runtime/tools/legacy-tool-runtime-bridge.ts',
  'dist/runtime/tools/legacy-tool-runtime-bridge.js',
  'src/runtime/tools/approval-command.ts',
  'dist/runtime/tools/approval-command.js',
  'src/runtime/tools/in-memory-pending-call-store.ts',
  'dist/runtime/tools/in-memory-pending-call-store.js',
  'src/runtime/tools/redis-approval-store.ts',
  'dist/runtime/tools/redis-approval-store.js',
  'src/agent/tools/approval-store.ts',
  'dist/agent/tools/approval-store.js',
  'src/agent/tools/pending-call-store.ts',
  'dist/agent/tools/pending-call-store.js'
]

async function readSource (file: string): Promise<string> {
  return await readFile(path.join(root, file), 'utf8')
}

test('retired Phase 5 model and control runtimes are deleted', async () => {
  for (const file of retiredPhaseFiveRuntimeFiles) {
    let error: NodeJS.ErrnoException | undefined
    try {
      await access(path.join(root, file))
    } catch (caught) {
      error = caught as NodeJS.ErrnoException
    }
    assert.equal(error?.code, 'ENOENT', `${file} must be deleted`)
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
