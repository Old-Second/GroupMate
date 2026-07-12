import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { findProjectRoot } from '../helpers/project-root.js'

const projectRoot = findProjectRoot(import.meta.url)
const runtimePath = path.join(projectRoot, 'dist', 'runtime', 'safe-chat-logging.js')

test('safe chat log summaries expose bounded metadata without message content', async () => {
  assert.equal(existsSync(runtimePath), true, 'compiled safe chat logging module must exist')

  const {
    createChatRequestLog,
    createChatResponseLog,
    createChatErrorLog,
    createToolExecutionLog
  } = await import(pathToFileURL(runtimePath).href)
  assert.equal(typeof createToolExecutionLog, 'function')
  assert.equal(typeof createChatErrorLog, 'function')
  const secretPrompt = 'secret prompt qq=123456 https://private.example/token'
  const secretResponse = 'secret response with private content'
  const request = createChatRequestLog({
    mode: 'api',
    stream: true,
    prompt: secretPrompt
  })
  const response = createChatResponseLog({
    mode: 'api',
    response: {
      text: secretResponse,
      thinking_text: 'private reasoning',
      toolCalls: [{ id: 'private-id', function: { arguments: '{"secret":true}' } }],
      conversationId: 'private-conversation-id'
    }
  })
  const tool = createToolExecutionLog({
    name: 'weather',
    result: 'secret tool result https://private.example'
  })
  const error = createChatErrorLog({
    mode: 'api',
    error: {
      name: 'ChatGPTError',
      code: 'rate_limit',
      statusCode: 429,
      message: 'secret provider response https://private.example',
      stack: 'private stack'
    }
  })

  assert.deepEqual(request, {
    event: 'chat.request',
    mode: 'api',
    stream: true,
    promptCharacters: secretPrompt.length
  })
  assert.deepEqual(response, {
    event: 'chat.response',
    mode: 'api',
    textCharacters: secretResponse.length,
    hasThinking: true,
    toolCallCount: 1,
    failed: false
  })
  assert.deepEqual(tool, {
    event: 'chat.tool.result',
    tool: 'weather',
    resultCharacters: 42
  })
  assert.deepEqual(error, {
    event: 'chat.error',
    mode: 'api',
    error: 'ChatGPTError',
    code: 'rate_limit',
    statusCode: 429
  })

  const serialized = JSON.stringify({ request, response, tool, error })
  assert.doesNotMatch(serialized, /secret|private|123456|https:|conversation|arguments/)
})

test('active chat sources do not pass raw conversation values to loggers', () => {
  const checks = [
    {
      file: 'apps/chat.js',
      patterns: [
        /logger\.info\(`chatgpt prompt: \$\{prompt\}`\)/,
        /logger\.(?:info|mark)\(\{ previousConversation \}\)/,
        /logger\.mark\(\{ conversation \}\)/,
        /logger\.info\(chatMessage\)/,
        /logger\.mark\('思考过程', thinking\)/,
        /logger\.(?:error|warn)\(err\)/
      ]
    },
    {
      file: 'model/core.js',
      patterns: [
        /logger\.debug\(system\)/,
        /logger\.info\(data\?\.text \|\| data\.functionCall \|\| data\)/,
        /logger\.info\(msg\)/,
        /logger\.mark\(`function \$\{name\} execution result: \$\{functionResult\}`\)/,
        /logger\.mark\(`\[chatgpt-plugin\] tool result feedback: name=\$\{toolName\}, toolCallId=\$\{option\.toolCallId\}`\)/,
        /logger\.(?:error|warn)\(err\)/
      ]
    }
  ]
  const offenders: string[] = []

  for (const check of checks) {
    const source = readFileSync(path.join(projectRoot, check.file), 'utf8')
    for (const pattern of check.patterns) {
      if (pattern.test(source)) offenders.push(`${check.file}: ${pattern.source}`)
    }
  }

  assert.deepEqual(offenders, [])
})
