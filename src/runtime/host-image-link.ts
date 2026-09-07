/**
 * Signed host image links.
 *
 * QQ serves message images from a CDN that authenticates every download with a
 * short-lived `rkey` query parameter. The key is not minted per image: the host
 * holds one key per scene (group and private) and rotates it about every 57
 * minutes, so a link captured in conversation history stops working shortly
 * after it was captured even though the stored file is still there.
 *
 * Replaying a dead link makes the provider reject the whole request, so history
 * links must carry the current key instead of the one captured with them. These
 * helpers stay pure: they recognise a refreshable link and rewrite its key,
 * while the host adapter owns fetching the keys themselves.
 */

export type HostImageLinkScene = 'group' | 'private'

export interface HostImageLinkKeys {
  readonly group?: string
  readonly private?: string
  /** When the host minted the keys. */
  readonly refreshedAtMs: number
  /** When the host will stop honouring them. */
  readonly expiresAtMs: number
}

export interface HostImageLink {
  readonly scene: HostImageLinkScene
  /** Stable identity of the stored file, independent of the signing key. */
  readonly fileKey: string
}

export const MAX_HOST_IMAGE_LINK_LENGTH = 8_192

// Only hosts whose download endpoint is known to authenticate with a scene key.
const REFRESHABLE_HOSTS = new Set([
  'multimedia.nt.qq.com.cn',
  'multimedia.nt.qq.com',
  'gchat.qpic.cn'
])

// NapCat stamps group downloads with appid 1407 and private ones with 1406. An
// unknown value leaves the link alone rather than risking the wrong key.
const SCENE_BY_APPID = new Map<string, HostImageLinkScene>([
  ['1407', 'group'],
  ['1406', 'private']
])

const RKEY_PARAMETER = /([?&]rkey=)([^&#]*)/
const SAFE_KEY = /^[A-Za-z0-9_-]{8,512}$/

export function hostImageLinkKey (
  keys: HostImageLinkKeys,
  scene: HostImageLinkScene
): string | undefined {
  const value = scene === 'group' ? keys.group : keys.private
  return value !== undefined && SAFE_KEY.test(value) ? value : undefined
}

/**
 * Normalizes a host key value.
 *
 * The host returns the key ready to be appended to a query string, so it may
 * arrive as `&rkey=<value>` rather than the bare value.
 */
export function normalizeHostImageLinkKey (value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const bare = value.replace(/^[?&]?rkey=/, '').trim()
  return SAFE_KEY.test(bare) ? bare : undefined
}

export function parseHostImageLink (value: unknown): HostImageLink | null {
  if (typeof value !== 'string' || value.length === 0 ||
    value.length > MAX_HOST_IMAGE_LINK_LENGTH) {
    return null
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (!REFRESHABLE_HOSTS.has(url.hostname)) return null
  if (!RKEY_PARAMETER.test(url.search)) return null
  const appid = url.searchParams.get('appid')
  const scene = appid === null ? undefined : SCENE_BY_APPID.get(appid)
  if (scene === undefined) return null
  const fileId = url.searchParams.get('fileid')
  const identity = fileId === null || fileId === '' ? url.pathname : fileId
  return Object.freeze({ scene, fileKey: `${appid}:${identity}` })
}

/**
 * Rewrites the signing key of a host image link.
 *
 * Only the key is replaced — the rest of the link is preserved byte for byte so
 * a re-encoded file identifier can never change which file the host serves.
 * Returns `null` when the link cannot carry a current key.
 */
export function refreshHostImageLink (
  value: unknown,
  keys: HostImageLinkKeys
): string | null {
  const link = parseHostImageLink(value)
  if (link === null) return null
  const key = hostImageLinkKey(keys, link.scene)
  if (key === undefined) return null
  const raw = value as string
  const match = RKEY_PARAMETER.exec(raw)
  if (match === null) return null
  if (match[2] === key) return raw
  // A second occurrence would leave a stale key behind the refreshed one.
  if (RKEY_PARAMETER.test(raw.slice(raw.indexOf(match[0]) + match[0].length))) return null
  const refreshed = raw.replace(RKEY_PARAMETER, `$1${key}`)
  if (refreshed.length > MAX_HOST_IMAGE_LINK_LENGTH) return null
  try {
    if (new URL(refreshed).searchParams.get('rkey') !== key) return null
  } catch {
    return null
  }
  return refreshed
}
