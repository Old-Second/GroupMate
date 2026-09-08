/**
 * How many system instructions each request kind carries, and how stable each
 * position is. Bridges `request.received` (what the controller passed) to
 * `provider.request` (what reached the wire), so an instruction injected
 * downstream of the controller shows up as a count mismatch.
 *
 * Aggregate only: counts, lengths and short salted digests, never content.
 *
 * Usage: node scripts/diagnose-system-instructions.mjs <journal-dir> [--since YYYY-MM-DD]
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const JOURNAL_FILE = /^groupmate-(\d{4}-\d{2}-\d{2})\.\d+\.jsonl$/
const MAX_TRACKED = 4096

function digest (text) {
  return createHash('sha256').update('groupmate.sysinstr.v1 ').update(text).digest('hex').slice(0, 8)
}

function record (map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function evict (map) {
  while (map.size > MAX_TRACKED) {
    const oldest = map.keys().next()
    if (oldest.done === true) return
    map.delete(oldest.value)
  }
}

async function scanFile (path, state) {
  const lines = createInterface({
    input: createReadStream(path, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  for await (const line of lines) {
    if (line.length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const event = parsed?.event
    const payload = event?.payload
    if (event?.type === 'request.received') {
      const request = payload?.request
      if (typeof request?.requestRef !== 'string') continue
      const instructions = Array.isArray(request.systemInstructions) ? request.systemInstructions : []
      state.received.set(request.requestRef, {
        kind: String(request.requestKind ?? 'unknown'),
        lengths: instructions.map(value => (typeof value === 'string' ? value.length : -1)),
        digests: instructions.map(value => (typeof value === 'string' ? digest(value) : 'x'))
      })
      evict(state.received)
      record(state.receivedCount, `${String(request.requestKind ?? 'unknown')} · ${instructions.length}`)
      continue
    }
    if (event?.type !== 'provider.request') continue
    const messages = payload?.request?.messages
    if (!Array.isArray(messages) || messages.length === 0) continue
    const seen = state.received.get(payload.requestRef)
    if (seen === undefined) continue
    const wire = []
    for (const message of messages) {
      if (message?.role !== 'system' || wire.length !== messages.indexOf(message)) break
      const content = typeof message.content === 'string' ? message.content : ''
      wire.push({ chars: content.length, digest: digest(content) })
    }
    record(state.wireCount, `${seen.kind} · received ${seen.lengths.length} · wire ${wire.length}`)
    for (const [index, entry] of wire.entries()) {
      const matchedPosition = seen.digests.indexOf(entry.digest)
      record(
        state.positionOrigin,
        `${seen.kind} · wire[${index}] · ${matchedPosition < 0 ? 'not_from_controller' : `received[${matchedPosition}]`}`
      )
      const variants = state.variantsAt.get(`${seen.kind} · wire[${index}]`) ?? new Map()
      record(variants, entry.digest)
      state.variantsAt.set(`${seen.kind} · wire[${index}]`, variants)
      const sizes = state.sizesAt.get(`${seen.kind} · wire[${index}]`) ??
        { min: Infinity, max: 0, requests: 0 }
      sizes.min = Math.min(sizes.min, entry.chars)
      sizes.max = Math.max(sizes.max, entry.chars)
      sizes.requests += 1
      state.sizesAt.set(`${seen.kind} · wire[${index}]`, sizes)
    }
  }
}

function sortedCounts (map) {
  return [...map.entries()].sort((left, right) => right[1] - left[1]).map(([label, count]) => ({ label, count }))
}

async function main () {
  const [directory, ...rest] = process.argv.slice(2)
  if (directory === undefined) {
    console.error('usage: node scripts/diagnose-system-instructions.mjs <journal-dir> [--since YYYY-MM-DD]')
    process.exitCode = 2
    return
  }
  const sinceIndex = rest.indexOf('--since')
  const since = sinceIndex < 0 ? undefined : rest[sinceIndex + 1]
  const state = {
    received: new Map(),
    receivedCount: new Map(),
    wireCount: new Map(),
    positionOrigin: new Map(),
    variantsAt: new Map(),
    sizesAt: new Map()
  }
  const files = (await readdir(directory))
    .map(name => ({ name, day: JOURNAL_FILE.exec(name)?.[1] }))
    .filter(entry => entry.day !== undefined && (since === undefined || entry.day >= since))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const file of files) await scanFile(join(directory, file.name), state)
  console.log(JSON.stringify({
    files: files.length,
    receivedInstructionCounts: sortedCounts(state.receivedCount),
    wireVsReceivedCounts: sortedCounts(state.wireCount),
    wirePositionOrigin: sortedCounts(state.positionOrigin),
    distinctVariantsPerPosition: [...state.variantsAt.entries()]
      .map(([label, variants]) => ({
        label,
        distinct: variants.size,
        top: sortedCounts(variants).slice(0, 4).map(entry => entry.count)
      }))
      .sort((left, right) => right.distinct - left.distinct),
    charsPerPosition: [...state.sizesAt.entries()].map(([label, sizes]) => ({
      label,
      requests: sizes.requests,
      minChars: sizes.min === Infinity ? null : sizes.min,
      maxChars: sizes.max
    }))
  }, null, 2))
}

await main()
