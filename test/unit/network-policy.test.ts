import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  NetworkPolicy,
  NetworkPolicyError,
  isPublicNetworkAddress,
  type NetworkRequestPolicy
} from '../../src/agent/tools/network-policy.js'
import {
  createPinnedLookup,
  PolicyFetch,
  type PolicyTransport,
  type PolicyTransportRequest,
  type PolicyTransportResponse
} from '../../src/runtime/tools/policy-fetch.js'

const openTextPolicy: NetworkRequestPolicy = {
  kind: 'open_http',
  maxBytes: 1_024,
  allowedContentTypes: ['text/plain']
}

function response (options: {
  status?: number
  statusText?: string
  headers?: Readonly<Record<string, string>>
  chunks?: readonly (string | Uint8Array)[]
} = {}): PolicyTransportResponse {
  return {
    status: options.status ?? 200,
    statusText: options.statusText ?? 'OK',
    headers: options.headers ?? { 'content-type': 'text/plain' },
    body: (async function * () {
      for (const chunk of options.chunks ?? ['content']) {
        yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      }
    })()
  }
}

test('network policy classifies only globally routable addresses as public', () => {
  const rejected = [
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1',
    '172.16.0.1', '192.0.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:93.184.216.34', 'fc00::1', 'fe80::1', 'ff00::1',
    '2001:db8::1', '2001::1', '2002::1', '64:ff9b::1'
  ]
  for (const address of rejected) assert.equal(isPublicNetworkAddress(address), false, address)
  assert.equal(isPublicNetworkAddress('93.184.216.34'), true)
  assert.equal(isPublicNetworkAddress('2001:4860:4860::8888'), true)
})

test('URL authorization rejects alternate loopback forms and unsafe URL syntax', async () => {
  const policy = new NetworkPolicy({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }]
  })
  const rejected = [
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://[::ffff:127.0.0.1]/',
    'http://localhost/',
    'http://service.localhost/',
    'http://user:password@example.test/',
    'file:///etc/passwd',
    'gopher://example.test/'
  ]
  for (const url of rejected) {
    await assert.rejects(policy.authorize(url, openTextPolicy), NetworkPolicyError, url)
  }
})

test('DNS authorization rejects the whole mixed public and private answer set', async () => {
  const policy = new NetworkPolicy({
    resolve: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 }
    ]
  })
  await assert.rejects(policy.authorize('https://example.test/', openTextPolicy), error => {
    return error instanceof NetworkPolicyError && error.code === 'private_address'
  })
})

test('fixed host policy enforces HTTPS origin, port and path prefixes', async () => {
  const policy = new NetworkPolicy({
    resolve: async () => [{ address: '93.184.216.34', family: 4 }]
  })
  const fixed: NetworkRequestPolicy = {
    kind: 'fixed_hosts',
    hosts: [{ hostname: 'api.example.test', port: 443, pathPrefixes: ['/v1/search'] }],
    maxBytes: 1_024,
    allowedContentTypes: ['application/json']
  }
  assert.equal((await policy.authorize('https://api.example.test/v1/search?q=x', fixed)).pinnedAddress, '93.184.216.34')
  await assert.rejects(policy.authorize('http://api.example.test/v1/search', fixed))
  await assert.rejects(policy.authorize('https://api.example.test:444/v1/search', fixed))
  await assert.rejects(policy.authorize('https://api.example.test/v1/other', fixed))
  await assert.rejects(policy.authorize('https://other.example.test/v1/search', fixed))
})

test('text response policy cannot raise the global one MiB ceiling', async () => {
  const policy = new NetworkPolicy({ resolve: async () => [{ address: '93.184.216.34', family: 4 }] })
  await assert.rejects(policy.authorize('https://example.test/', {
    kind: 'open_http', maxBytes: 1024 * 1024 + 1, allowedContentTypes: ['text/plain']
  }), TypeError)
})

test('pinned lookup honors the Node 22 all-address callback contract', async () => {
  const lookup = createPinnedLookup('93.184.216.34', 4)
  const resolve = async (all: boolean): Promise<{ address: string | { address: string, family: number }[], family?: number }> => {
    return await new Promise((resolve, reject) => {
      lookup('example.test', { all }, (error, address, family) => {
        if (error !== null) {
          reject(error)
          return
        }
        resolve({ address, family })
      })
    })
  }

  assert.deepEqual(await resolve(false), { address: '93.184.216.34', family: 4 })
  assert.deepEqual(await resolve(true), {
    address: [{ address: '93.184.216.34', family: 4 }],
    family: undefined
  })
})

test('PolicyFetch pins the approved address and returns a bounded response', async () => {
  const calls: PolicyTransportRequest[] = []
  const transport: PolicyTransport = {
    request: async request => {
      calls.push(request)
      return response({ chunks: ['content'] })
    }
  }
  const policyFetch = new PolicyFetch({
    networkPolicy: new NetworkPolicy({
      resolve: async () => [{ address: '93.184.216.34', family: 4 }]
    }),
    transport
  })
  const result = await policyFetch.request({
    url: 'https://example.test/page?private=query',
    policy: openTextPolicy,
    timeoutMs: 1_000
  })
  assert.equal(Buffer.from(result.body).toString(), 'content')
  assert.equal(result.finalUrl, 'https://example.test/page')
  assert.equal(calls[0].pinnedAddress, '93.184.216.34')
  assert.equal(calls[0].url.hostname, 'example.test')
})

test('redirects are reauthorized and strip sensitive headers across origins', async () => {
  const calls: PolicyTransportRequest[] = []
  const transport: PolicyTransport = {
    request: async request => {
      calls.push(request)
      if (calls.length === 1) {
        return response({ status: 302, headers: { location: 'https://other.test/final' }, chunks: [] })
      }
      return response({ chunks: ['done'] })
    }
  }
  const policyFetch = new PolicyFetch({
    networkPolicy: new NetworkPolicy({
      resolve: async hostname => [{
        address: hostname === 'example.test' ? '93.184.216.34' : '8.8.8.8', family: 4
      }]
    }),
    transport
  })
  const result = await policyFetch.request({
    url: 'https://example.test/start',
    policy: openTextPolicy,
    timeoutMs: 1_000,
    headers: { authorization: 'Bearer secret', cookie: 'secret=1', accept: 'text/plain' }
  })
  assert.equal(Buffer.from(result.body).toString(), 'done')
  assert.equal(calls.length, 2)
  assert.equal(calls[0].headers.authorization, 'Bearer secret')
  assert.equal(calls[1].headers.authorization, undefined)
  assert.equal(calls[1].headers.cookie, undefined)
  assert.equal(calls[1].headers.accept, 'text/plain')
  assert.equal(calls[1].pinnedAddress, '8.8.8.8')
})

test('redirect limit is fixed at three hops', async () => {
  let calls = 0
  const policyFetch = new PolicyFetch({
    networkPolicy: new NetworkPolicy({ resolve: async () => [{ address: '93.184.216.34', family: 4 }] }),
    transport: {
      request: async request => {
        calls += 1
        return response({ status: 302, headers: { location: `/hop-${calls}` }, chunks: [] })
      }
    }
  })
  await assert.rejects(policyFetch.request({
    url: 'https://example.test/start', policy: openTextPolicy, timeoutMs: 1_000
  }), error => error instanceof NetworkPolicyError && error.code === 'redirect_limit')
  assert.equal(calls, 4)
})

test('content type and Content-Length are checked before body consumption', async () => {
  let bodyReads = 0
  const body = {
    async * [Symbol.asyncIterator] () {
      bodyReads += 1
      yield Buffer.from('never')
    }
  }
  const responses = [
    { status: 200, statusText: 'OK', headers: { 'content-type': 'text/html' }, body },
    { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain', 'content-length': '2048' }, body }
  ]
  const policyFetch = new PolicyFetch({
    networkPolicy: new NetworkPolicy({ resolve: async () => [{ address: '93.184.216.34', family: 4 }] }),
    transport: { request: async () => responses.shift() as PolicyTransportResponse }
  })
  await assert.rejects(policyFetch.request({
    url: 'https://example.test/type', policy: openTextPolicy, timeoutMs: 1_000
  }), error => error instanceof NetworkPolicyError && error.code === 'content_type_denied')
  await assert.rejects(policyFetch.request({
    url: 'https://example.test/length', policy: openTextPolicy, timeoutMs: 1_000
  }), error => error instanceof NetworkPolicyError && error.code === 'response_too_large')
  assert.equal(bodyReads, 0)
})

test('chunked body aborts at the byte limit without returning partial data', async () => {
  let transportSignal: AbortSignal | undefined
  const policyFetch = new PolicyFetch({
    networkPolicy: new NetworkPolicy({ resolve: async () => [{ address: '93.184.216.34', family: 4 }] }),
    transport: {
      request: async request => {
        transportSignal = request.signal
        return response({ chunks: [new Uint8Array(700), new Uint8Array(400)] })
      }
    }
  })
  await assert.rejects(policyFetch.request({
    url: 'https://example.test/chunked', policy: openTextPolicy, timeoutMs: 1_000
  }), error => error instanceof NetworkPolicyError && error.code === 'response_too_large')
  assert.equal(transportSignal?.aborted, true)
})

test('timeout and caller cancellation return redacted fixed errors', async () => {
  const transport: PolicyTransport = {
    request: request => new Promise((_resolve, reject) => {
      request.signal.addEventListener('abort', () => reject(new Error('https://secret.invalid/?token=value')), { once: true })
    })
  }
  const policyFetch = new PolicyFetch({
    networkPolicy: new NetworkPolicy({ resolve: async () => [{ address: '93.184.216.34', family: 4 }] }),
    transport
  })
  await assert.rejects(policyFetch.request({
    url: 'https://example.test/slow?token=secret', policy: openTextPolicy, timeoutMs: 100
  }), error => {
    assert.ok(error instanceof NetworkPolicyError)
    assert.equal(error.code, 'network_timeout')
    assert.doesNotMatch(JSON.stringify(error), /example|secret|token|invalid/)
    return true
  })

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(policyFetch.request({
    url: 'https://example.test/cancel', policy: openTextPolicy, timeoutMs: 1_000,
    signal: controller.signal
  }), error => error instanceof NetworkPolicyError && error.code === 'network_cancelled')
})

test('timeout also interrupts a resolver that ignores cancellation', async () => {
  const policyFetch = new PolicyFetch({
    networkPolicy: new NetworkPolicy({
      resolve: async () => new Promise(resolve => {
        setTimeout(() => resolve([{ address: '93.184.216.34', family: 4 }]), 250)
      })
    }),
    transport: { request: async () => response() }
  })
  const startedAt = Date.now()
  await assert.rejects(policyFetch.request({
    url: 'https://resolver.test/slow', policy: openTextPolicy, timeoutMs: 100
  }), error => error instanceof NetworkPolicyError && error.code === 'network_timeout')
  assert.ok(Date.now() - startedAt < 200)
})

test('open HTTP implementation has no Chromium or provider proxy fallback', async () => {
  const source = await readFile('src/runtime/tools/policy-fetch.ts', 'utf8')
  assert.doesNotMatch(source, /ChatGPTPuppeteer|puppeteer|browser|proxyAgent|providerProxy/i)
})
