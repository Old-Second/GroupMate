import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export interface FixedHostRule {
  readonly hostname: string
  readonly port?: number
  readonly pathPrefixes: readonly string[]
}

export type NetworkRequestPolicy =
  | {
      readonly kind: 'fixed_hosts'
      readonly hosts: readonly FixedHostRule[]
      readonly maxBytes: number
      readonly allowedContentTypes: readonly string[]
    }
  | {
      readonly kind: 'open_http'
      readonly maxBytes: number
      readonly allowedContentTypes: readonly string[]
    }

export interface ResolvedNetworkAddress {
  readonly address: string
  readonly family: 4 | 6
}

export interface AuthorizedNetworkTarget {
  readonly url: URL
  readonly pinnedAddress: string
  readonly family: 4 | 6
}

export type NetworkPolicyErrorCode =
  | 'invalid_url'
  | 'scheme_denied'
  | 'credentials_denied'
  | 'host_denied'
  | 'path_denied'
  | 'private_address'
  | 'dns_resolution_failed'
  | 'network_timeout'
  | 'network_cancelled'
  | 'network_failed'
  | 'redirect_limit'
  | 'redirect_invalid'
  | 'content_type_denied'
  | 'response_too_large'

const errorMessages: Readonly<Record<NetworkPolicyErrorCode, string>> = Object.freeze({
  invalid_url: '网络地址无效。',
  scheme_denied: '不允许访问该网络协议。',
  credentials_denied: '网络地址不能包含身份凭据。',
  host_denied: '不允许访问该网络主机。',
  path_denied: '不允许访问该网络路径。',
  private_address: '不允许访问非公网地址。',
  dns_resolution_failed: '网络地址解析失败。',
  network_timeout: '网络请求超时。',
  network_cancelled: '网络请求已取消。',
  network_failed: '网络请求失败。',
  redirect_limit: '网络重定向次数过多。',
  redirect_invalid: '网络重定向地址无效。',
  content_type_denied: '网络响应类型不受支持。',
  response_too_large: '网络响应内容过大。'
})

export class NetworkPolicyError extends Error {
  readonly code: NetworkPolicyErrorCode
  readonly userMessage: string

  constructor (code: NetworkPolicyErrorCode) {
    super(errorMessages[code])
    this.name = 'NetworkPolicyError'
    this.code = code
    this.userMessage = errorMessages[code]
  }

  toJSON (): Readonly<{ name: 'NetworkPolicyError'; code: NetworkPolicyErrorCode; userMessage: string }> {
    return Object.freeze({ name: 'NetworkPolicyError', code: this.code, userMessage: this.userMessage })
  }
}

type NetworkResolver = (
  hostname: string,
  signal: AbortSignal
) => Promise<readonly ResolvedNetworkAddress[]>

export interface NetworkPolicyOptions {
  readonly resolve?: NetworkResolver
}

function ipv4Number (address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255 || String(octet) !== part) return null
    value = value * 256 + octet
  }
  return value >>> 0
}

function inIpv4Range (value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (value & mask) === (base & mask)
}

function publicIpv4 (address: string): boolean {
  const value = ipv4Number(address)
  if (value === null) return false
  const denied: readonly [number, number][] = [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
    [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
    [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24],
    [0xe0000000, 4], [0xf0000000, 4]
  ]
  return !denied.some(([base, prefix]) => inIpv4Range(value, base, prefix))
}

function ipv6Words (address: string): number[] | null {
  if (address.includes('%') || address.includes('.')) return null
  const pieces = address.toLowerCase().split('::')
  if (pieces.length > 2) return null
  const left = pieces[0] === '' ? [] : pieces[0].split(':')
  const right = pieces.length === 1 || pieces[1] === '' ? [] : pieces[1].split(':')
  if (pieces.length === 1 && left.length !== 8) return null
  if (pieces.length === 2 && left.length + right.length >= 8) return null
  const missing = pieces.length === 2 ? 8 - left.length - right.length : 0
  const words = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  if (words.length !== 8 || words.some(word => !/^[0-9a-f]{1,4}$/.test(word))) return null
  return words.map(word => Number.parseInt(word, 16))
}

function publicIpv6 (address: string): boolean {
  const words = ipv6Words(address)
  if (words === null) return false
  const [first, second] = words
  if ((first & 0xe000) !== 0x2000) return false
  if (first === 0x2001 && (second === 0x0000 || second === 0x0002 || second === 0x0db8 || (second >= 0x0010 && second <= 0x001f))) return false
  if (first === 0x2002) return false
  if (first === 0x0064 && second === 0xff9b && words.slice(2, 6).every(word => word === 0)) return false
  return true
}

export function isPublicNetworkAddress (address: string): boolean {
  const family = isIP(address)
  if (family === 4) return publicIpv4(address)
  if (family === 6) return publicIpv6(address)
  return false
}

function cleanHostname (hostname: string): string {
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
  return unwrapped.replace(/\.$/, '').toLowerCase()
}

function validatePolicy (policy: NetworkRequestPolicy): void {
  if (!Number.isSafeInteger(policy.maxBytes) || policy.maxBytes <= 0 || policy.maxBytes > 8 * 1024 * 1024 ||
    !Array.isArray(policy.allowedContentTypes) || policy.allowedContentTypes.length === 0 || policy.allowedContentTypes.length > 32 ||
    policy.allowedContentTypes.some(type => typeof type !== 'string' || !/^[a-z0-9.+-]+\/(?:[a-z0-9.+*-]+)$/.test(type))) {
    throw new TypeError('network request policy is invalid')
  }
  const textOnly = policy.allowedContentTypes.every(type =>
    type.startsWith('text/') || /^(?:application\/(?:json|[^/]+\+json|xml|[^/]+\+xml|javascript))$/.test(type))
  if (textOnly && policy.maxBytes > 1024 * 1024) throw new TypeError('text response byte limit is invalid')
  if (policy.kind === 'fixed_hosts' && (!Array.isArray(policy.hosts) || policy.hosts.length === 0 || policy.hosts.length > 32)) {
    throw new TypeError('fixed host policy is invalid')
  }
}

function withAbort<T> (operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(new NetworkPolicyError('network_cancelled'))
    }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      value => { cleanup(); resolve(value) },
      error => { cleanup(); reject(error) }
    )
  })
}

function pathAllowed (pathname: string, prefix: string): boolean {
  if (!prefix.startsWith('/') || prefix.includes('?') || prefix.includes('#')) return false
  return pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)
}

export class NetworkPolicy {
  readonly #resolve: NetworkResolver

  constructor (options: NetworkPolicyOptions = {}) {
    this.#resolve = options.resolve ?? (async (hostname, signal) => {
      if (signal.aborted) throw new NetworkPolicyError('network_cancelled')
      const addresses = await lookup(hostname, { all: true, verbatim: true })
      if (signal.aborted) throw new NetworkPolicyError('network_cancelled')
      return addresses.map(item => ({ address: item.address, family: item.family as 4 | 6 }))
    })
  }

  async authorize (
    inputUrl: string | URL,
    policy: NetworkRequestPolicy,
    signal = new AbortController().signal
  ): Promise<AuthorizedNetworkTarget> {
    if (signal.aborted) throw new NetworkPolicyError('network_cancelled')
    validatePolicy(policy)
    let url: URL
    try {
      url = new URL(inputUrl)
    } catch {
      throw new NetworkPolicyError('invalid_url')
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new NetworkPolicyError('scheme_denied')
    if (url.username !== '' || url.password !== '') throw new NetworkPolicyError('credentials_denied')
    const hostname = cleanHostname(url.hostname)
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.length === 0 || hostname.length > 253) {
      throw new NetworkPolicyError('host_denied')
    }

    if (policy.kind === 'fixed_hosts') {
      if (url.protocol !== 'https:') throw new NetworkPolicyError('scheme_denied')
      const port = url.port === '' ? 443 : Number(url.port)
      const rule = policy.hosts.find(candidate =>
        cleanHostname(candidate.hostname) === hostname && (candidate.port ?? 443) === port)
      if (rule === undefined) throw new NetworkPolicyError('host_denied')
      if (!rule.pathPrefixes.some(prefix => pathAllowed(url.pathname, prefix))) throw new NetworkPolicyError('path_denied')
    }

    let addresses: readonly ResolvedNetworkAddress[]
    const family = isIP(hostname)
    if (family === 4 || family === 6) {
      addresses = [{ address: hostname, family }]
    } else {
      try {
        addresses = await withAbort(this.#resolve(hostname, signal), signal)
      } catch (error) {
        if (error instanceof NetworkPolicyError) throw error
        if (signal.aborted) throw new NetworkPolicyError('network_cancelled')
        throw new NetworkPolicyError('dns_resolution_failed')
      }
    }
    if (addresses.length === 0 || addresses.length > 32 ||
      addresses.some(item => (item.family !== 4 && item.family !== 6) || !isPublicNetworkAddress(item.address))) {
      throw new NetworkPolicyError('private_address')
    }
    return Object.freeze({
      url,
      pinnedAddress: addresses[0].address,
      family: addresses[0].family
    })
  }
}
