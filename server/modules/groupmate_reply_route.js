import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import {
  parseGroupMatePictureRemoteRequest,
  renderGroupMateHtml
} from '../../dist/runtime/presentation/groupmate-picture-contract.js'

const TTL_MILLISECONDS = 600_000
const MAX_DOCUMENTS = 64
const INVALID_REQUEST = Object.freeze({ schemaVersion: 1, error: 'invalid_request' })
const TEMPORARILY_UNAVAILABLE = Object.freeze({
  schemaVersion: 1, error: 'temporarily_unavailable'
})

function mediaType (request) {
  const value = request.headers['content-type']
  return typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : ''
}

function fixedError (reply, status, body) {
  return reply.code(status).type('application/json; charset=utf-8').send(body)
}

export default async function groupMateReplyRoute (fastify, options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now
  const randomBytes = typeof options.randomBytes === 'function'
    ? options.randomBytes
    : nodeRandomBytes
  const template = typeof options.template === 'string'
    ? options.template
    : await readFile(new URL('../../resources/reply/groupmate.html', import.meta.url), 'utf8')
  const documents = new Map()

  // This parser replacement is encapsulated to this plugin scope. Parent/sibling
  // routes retain Fastify's default JSON object parser.
  fastify.removeContentTypeParser('application/json')
  fastify.addContentTypeParser('application/json', {
    parseAs: 'string',
    bodyLimit: 64 * 1024
  }, (_request, body, done) => done(null, body))

  fastify.setErrorHandler((error, _request, reply) => {
    if (error?.code === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
      error?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return fixedError(reply, 400, INVALID_REQUEST)
    }
    return fixedError(reply, 503, TEMPORARILY_UNAVAILABLE)
  })

  function evictExpired () {
    const current = now()
    for (const [token, value] of documents) {
      if (value.expiresAt > current) continue
      documents.delete(token)
    }
  }

  function makeRoom () {
    evictExpired()
    while (documents.size >= MAX_DOCUMENTS) {
      const oldest = documents.keys().next().value
      if (typeof oldest !== 'string') break
      documents.delete(oldest)
    }
  }

  fastify.post('/groupmate/reply/v1', async (request, reply) => {
    if (mediaType(request) !== 'application/json' || typeof request.body !== 'string') {
      return fixedError(reply, 400, INVALID_REQUEST)
    }
    const parsed = parseGroupMatePictureRemoteRequest(request.body)
    if (parsed === null) return fixedError(reply, 400, INVALID_REQUEST)

    let html
    try {
      html = renderGroupMateHtml(template, parsed)
    } catch {
      return fixedError(reply, 503, TEMPORARILY_UNAVAILABLE)
    }
    makeRoom()
    let token = null
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const bytes = randomBytes(16)
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) break
        const candidate = Buffer.from(bytes).toString('hex')
        if (/^[0-9a-f]{32}$/.test(candidate) && !documents.has(candidate)) {
          token = candidate
          break
        }
      } catch {
        break
      }
    }
    if (token === null) return fixedError(reply, 503, TEMPORARILY_UNAVAILABLE)
    documents.set(token, Object.freeze({ html, expiresAt: now() + TTL_MILLISECONDS }))
    return reply.code(201).send(Object.freeze({
      schemaVersion: 1,
      pagePath: `/groupmate/reply/v1/${token}`,
      expiresInSeconds: 600
    }))
  })

  fastify.get('/groupmate/reply/v1/:token', async (request, reply) => {
    evictExpired()
    const token = request.params?.token
    if (typeof token !== 'string' || !/^[0-9a-f]{32}$/.test(token)) {
      return reply.code(404).send()
    }
    const value = documents.get(token)
    if (value === undefined || value.expiresAt <= now()) {
      documents.delete(token)
      return reply.code(404).send()
    }
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:"
      )
      .send(value.html)
  })
}
