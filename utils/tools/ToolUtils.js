import net from 'net'
import fetch from 'node-fetch'
import { Config } from '../config.js'
import { getMasterQQ } from '../common.js'

export function clampNumber (value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(Math.max(Math.trunc(parsed), min), max)
}

export function previewBody (body, maxLength = 300) {
  return String(body || '').replace(/\s+/g, ' ').slice(0, maxLength)
}

export function truncateText (text, maxLength = 1200) {
  if (typeof text !== 'string') {
    return text
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text
}

export async function fetchTextWithTimeout (url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      ...options,
      signal: controller.signal
    })
    const contentType = resp.headers.get('content-type') || ''
    const body = await resp.text()
    return { resp, contentType, body }
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchJsonWithTimeout (url, options = {}, timeoutMs = 30000) {
  const { resp, contentType, body } = await fetchTextWithTimeout(url, options, timeoutMs)
  if (!resp.ok || !contentType.includes('application/json')) {
    return {
      resp,
      contentType,
      body,
      json: null,
      error: `upstream returned ${resp.status} ${resp.statusText || ''}, content-type=${contentType || 'unknown'}, body preview=${previewBody(body)}`
    }
  }
  try {
    return {
      resp,
      contentType,
      body,
      json: JSON.parse(body),
      error: null
    }
  } catch (err) {
    return {
      resp,
      contentType,
      body,
      json: null,
      error: `upstream returned invalid JSON: ${err.message}`
    }
  }
}

export function isPrivateUrl (url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch (err) {
    return true
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return true
  }
  const host = parsed.hostname.toLowerCase()
  if (['localhost', '0.0.0.0'].includes(host) || host.endsWith('.localhost')) {
    return true
  }
  const ipType = net.isIP(host)
  if (ipType === 4) {
    const parts = host.split('.').map(Number)
    return parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254)
  }
  if (ipType === 6) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
  }
  return false
}

export async function fetchImageBuffer (url, maxBytes = 8 * 1024 * 1024) {
  if (isPrivateUrl(url)) {
    throw new Error('invalid or private image url')
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(`image request failed: ${response.status} ${response.statusText || ''}`)
    }
    const contentType = response.headers.get('content-type') || ''
    if (!contentType.startsWith('image/')) {
      throw new Error(`url is not an image, content-type=${contentType || 'unknown'}`)
    }
    const contentLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`image is too large: ${contentLength} bytes`)
    }
    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(`image is too large: ${arrayBuffer.byteLength} bytes`)
    }
    return {
      buffer: Buffer.from(arrayBuffer),
      contentType
    }
  } finally {
    clearTimeout(timeout)
  }
}

export function resolveTarget (e, targetGroupIdOrQQNumber) {
  const defaultTarget = e.isGroup ? e.group_id : (e.sender?.user_id ?? e.user_id)
  if (!e.isGroup && !Config.enableToolCrossGroupSend) {
    return defaultTarget
  }
  if (isNaN(targetGroupIdOrQQNumber) || !targetGroupIdOrQQNumber) {
    return defaultTarget
  }
  const target = parseInt(targetGroupIdOrQQNumber)
  return target + '' === e.bot.uin + '' ? defaultTarget : target
}

export function normalizeQQ (qq) {
  return qq === undefined || qq === null ? '' : String(qq).trim()
}

export async function getMasterQQList () {
  const masters = await getMasterQQ()
  return Array.isArray(masters) ? masters.map(normalizeQQ).filter(Boolean) : []
}

export function isQQInList (list, qq) {
  return list.includes(normalizeQQ(qq))
}

export function getGroupEntry (groupList, target) {
  const targetId = normalizeQQ(target)
  if (!targetId || !groupList) {
    return undefined
  }
  if (typeof groupList.get === 'function') {
    return groupList.get(target) || groupList.get(targetId) || groupList.get(Number(targetId))
  }
  if (Array.isArray(groupList)) {
    return groupList.find(group => {
      const groupId = group?.group_id ?? group?.groupId ?? group?.id ?? group?.group
      return normalizeQQ(groupId) === targetId
    })
  }
  if (typeof groupList === 'object') {
    return groupList[targetId] || groupList[Number(targetId)] ||
      Object.values(groupList).find(group => {
        const groupId = group?.group_id ?? group?.groupId ?? group?.id ?? group?.group
        return normalizeQQ(groupId) === targetId
      })
  }
  return undefined
}

export function isTargetGroup (e, groupList, target) {
  if (e.isGroup && normalizeQQ(target) === normalizeQQ(e.group_id)) {
    return true
  }
  return Boolean(getGroupEntry(groupList, target))
}

export function isCurrentTarget (e, target) {
  const currentTarget = e.isGroup ? e.group_id : (e.sender?.user_id ?? e.user_id)
  return normalizeQQ(target) === normalizeQQ(currentTarget)
}

export async function isMasterQQ (sender, e) {
  const masters = await getMasterQQList()
  const isMaster = isQQInList(masters, sender) || isQQInList(masters, e.sender?.user_id)
  return { isMaster, masters }
}

export async function canSendToTarget (e, target, sender) {
  const { isMaster, masters } = await isMasterQQ(sender, e)
  if (isMaster) {
    return { allowed: true, masters, isMaster }
  }
  const currentTarget = e.isGroup ? e.group_id : (e.sender?.user_id ?? e.user_id)
  if (target + '' !== currentTarget + '' && !Config.enableToolCrossGroupSend) {
    return {
      allowed: false,
      masters,
      isMaster,
      reason: 'cross-group or cross-user sending is disabled for non-master users'
    }
  }
  return { allowed: true, masters, isMaster }
}

export function normalizeBoolean (value) {
  return value === true || value === 'true'
}

export function formatToolError (err) {
  if (!err) {
    return 'unknown error'
  }
  if (err.message) {
    return err.message
  }
  try {
    const json = JSON.stringify(err)
    if (json && json !== '{}') {
      return json
    }
  } catch (e) {}
  const text = String(err)
  return text && text !== '[object Object]' ? text : 'unknown object error'
}
