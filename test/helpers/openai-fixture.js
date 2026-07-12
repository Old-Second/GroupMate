import { readFile } from 'node:fs/promises'

const OPENAI_FIXTURES = new URL('../fixtures/openai/', import.meta.url)

export async function loadTextFixture (name) {
  return readFile(new URL(name, OPENAI_FIXTURES), 'utf8')
}

export async function loadJsonFixture (name) {
  return JSON.parse(await loadTextFixture(name))
}

export function createJsonResponse (value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Fixture Error',
    async json () { return structuredClone(value) },
    async text () { return JSON.stringify(value) }
  }
}

export function createSseResponse (value, status = 200) {
  return new Response(value, {
    status,
    headers: { 'content-type': 'text/event-stream' }
  })
}
