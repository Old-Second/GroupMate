import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { test } from 'node:test'
import { createParser } from 'eventsource-parser'

const FIXTURE_ROOT = new URL('../fixtures/', import.meta.url)
const forbidden = [
  /sk-[A-Za-z0-9_-]{12,}/,
  /Bearer\s+[A-Za-z0-9._-]{12,}/i,
  /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|cookie)["']?\s*[:=]\s*["']?[^\s"',}]{8,}/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b[1-9][0-9]{7,11}\b/,
  /https?:\/\/(?!fixture\.invalid(?:[/:]|$))[^\s"']+/i
]
const promptKeys = new Set(['prompt', 'system', 'systemMessage', 'messages'])

async function listFiles (directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    const target = new URL(entry.name, directory)
    return entry.isDirectory() ? listFiles(new URL(`${entry.name}/`, directory)) : [target]
  }))
  return nested.flat()
}

function assertPromptDataIsSynthetic (value, key = '') {
  if (promptKeys.has(key)) {
    const serialized = JSON.stringify(value)
    assert.ok(serialized.length <= 1024, `${key} fixture exceeds 1024 characters`)
    assert.match(serialized, /fixture/i, `${key} fixture must identify itself as synthetic`)
  }
  if (Array.isArray(value)) {
    value.forEach(item => assertPromptDataIsSynthetic(item, key))
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([childKey, child]) => assertPromptDataIsSynthetic(child, childKey))
  }
}

function assertFixtureUrlsAreSynthetic (value, label) {
  if (typeof value === 'string') {
    for (const candidate of value.match(/https?:\/\/[^\s"']+/gi) ?? []) {
      const url = new URL(candidate)
      assert.equal(url.hostname, 'fixture.invalid', `${label} contains non-fixture endpoint ${candidate}`)
    }
  } else if (Array.isArray(value)) {
    value.forEach(item => assertFixtureUrlsAreSynthetic(item, label))
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(child => assertFixtureUrlsAreSynthetic(child, label))
  }
}

function assertParsedFixtureSafe (value, label) {
  assertPromptDataIsSynthetic(value)
  assertFixtureUrlsAreSynthetic(value, label)
}

function assertSseDataIsSynthetic (content, label) {
  const parser = createParser(event => {
    if (event.type !== 'event' || event.data === '[DONE]') return
    let data
    try {
      data = JSON.parse(event.data)
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      throw new SyntaxError(`${label} contains non-JSON SSE data event`, { cause: error })
    }
    assertParsedFixtureSafe(data, label)
  })
  parser.feed(`${content}\n\n`)
}

function assertFixtureSafe (content, label) {
  for (const pattern of forbidden) {
    assert.doesNotMatch(content, pattern, `${label} contains ${pattern}`)
  }
  try {
    assertParsedFixtureSafe(JSON.parse(content), label)
  } catch (error) {
    if (error instanceof SyntaxError) {
      assertSseDataIsSynthetic(content, label)
      return
    }
    throw error
  }
}

test('fixture detector rejects standard JSON credentials and real endpoints', () => {
  for (const content of [
    '{"api_key":"fixture-secret-123"}',
    '{"access_token":"fixture-secret-123"}',
    '{"endpoint":"https://api.openai.com/v1"}'
  ]) {
    assert.throws(() => assertFixtureSafe(content, 'negative example'))
  }
  assert.doesNotThrow(() => assertFixtureSafe(
    '{"messages":[{"role":"user","content":"fixture question"}],"endpoint":"https://fixture.invalid/v1"}',
    'safe example'
  ))
})

test('fixture detector rejects escaped JSON endpoints', () => {
  assert.throws(() => assertFixtureSafe(
    String.raw`{"endpoint":"https:\/\/api.openai.com\/v1"}`,
    'escaped endpoint'
  ))
})

test('fixture detector rejects userinfo URLs with a real hostname', () => {
  assert.throws(() => assertFixtureSafe(
    '{"endpoint":"https://fixture.invalid:443@api.openai.com/v1"}',
    'userinfo endpoint'
  ))
})

test('fixture detector checks synthetic prompt data in SSE events', () => {
  assert.throws(() => assertFixtureSafe(
    'data: private question\n\n',
    'SSE non-JSON data'
  ), {
    name: 'SyntaxError',
    message: 'SSE non-JSON data contains non-JSON SSE data event'
  })
  assert.throws(() => assertFixtureSafe(
    'data: {"messages":[{"role":"user","content":"private question"}]}\n\n',
    'SSE private prompt'
  ))
  assert.doesNotThrow(() => assertFixtureSafe(
    'data: {"messages":[{"role":"user","content":"fixture question"}]}\n\n',
    'SSE synthetic prompt'
  ))
})

test('fixture detector allows SSE comments and the DONE sentinel', () => {
  assert.doesNotThrow(() => assertFixtureSafe(
    ': fixture keep-alive\n\ndata: [DONE]\n\n',
    'SSE control records'
  ))
})

test('fixture detector rejects other standard sensitive values and prompts', () => {
  for (const content of [
    'Authorization: Bearer fixture-secret-123',
    '{"cookie":"fixture-session-123"}',
    '-----BEGIN PRIVATE KEY-----\nfixture material\n-----END PRIVATE KEY-----',
    '{"qq":"12345678"}',
    '{"prompt":"private question"}'
  ]) {
    assert.throws(() => assertFixtureSafe(content, 'negative example'))
  }
})

test('stream fixture dispatches the DONE sentinel through eventsource-parser', async () => {
  const events = []
  const parser = createParser(event => {
    if (event.type === 'event') events.push(event.data)
  })
  parser.feed(await readFile(new URL('../fixtures/openai/stream-single-tool.sse', import.meta.url), 'utf8'))
  assert.equal(events.at(-1), '[DONE]')
})

test('tracked fixtures are bounded and redacted', async () => {
  const files = await listFiles(FIXTURE_ROOT)
  assert.ok(files.length > 0)
  for (const file of files) {
    assert.ok((await stat(file)).size <= 64 * 1024, `${file.pathname} exceeds 64 KiB`)
    const content = await readFile(file, 'utf8')
    assertFixtureSafe(content, file.pathname)
  }
})
