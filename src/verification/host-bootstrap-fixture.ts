// Shared machinery for the `index.js` host-bootstrap migration baselines. Every batch captures the
// pre-migration behaviour by reading `index.js` from a pinned commit, slicing the declarations it is
// about to move, executing them for real, and recording the results. Only the encoding, slicing and
// serialization live here; what to slice and which inputs to feed it stay with each batch.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export type Encoded =
  | null
  | boolean
  | number
  | string
  | readonly Encoded[]
  | { readonly [key: string]: Encoded }

const SPECIALS: ReadonlyMap<string, unknown> = new Map<string, unknown>([
  ['undefined', undefined],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['-0', -0]
])

// Truncation limits like 16384 characters only get probed by inputs that actually exceed them, and
// the committed fixture has a hard 64 KiB budget. Single-character runs therefore travel folded.
const RUN_THRESHOLD = 64

function repeatedUnit (value: string): string | null {
  const unit = [...value][0]
  if (unit === undefined) return null
  const count = value.length / unit.length
  if (!Number.isInteger(count) || count < RUN_THRESHOLD) return null
  return unit.repeat(count) === value ? unit : null
}

export function encodeValue (value: unknown): Encoded {
  if (value === undefined) return { '@': 'undefined' }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { '@': 'NaN' }
    if (value === Number.POSITIVE_INFINITY) return { '@': 'Infinity' }
    if (value === Number.NEGATIVE_INFINITY) return { '@': '-Infinity' }
    if (value === 0 && Object.is(value, -0)) return { '@': '-0' }
    return value
  }
  if (typeof value === 'string') {
    const unit = repeatedUnit(value)
    return unit === null
      ? value
      : { '@': 'repeat', unit, count: value.length / unit.length }
  }
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return { '@': 'bigint', digits: value.toString() }
  if (value instanceof Error) {
    return { '@': 'error', name: value.name, message: encodeValue(value.message) }
  }
  if (value instanceof Date) {
    return { '@': 'date', time: Number.isNaN(value.getTime()) ? 'NaN' : value.toISOString() }
  }
  if (value instanceof Map) {
    return { '@': 'map', entries: [...value].map(([key, item]) => [encodeValue(key), encodeValue(item)]) }
  }
  if (Buffer.isBuffer(value)) return { '@': 'buffer', base64: value.toString('base64') }
  if (Array.isArray(value)) return value.map(encodeValue)
  if (typeof value === 'function') return { '@': 'function', name: value.name }
  if (typeof value === 'object') {
    const result: Record<string, Encoded> = {}
    for (const [key, item] of Object.entries(value)) result[key] = encodeValue(item)
    return result
  }
  return { '@': `unsupported:${typeof value}` }
}

export function decodeValue (value: Encoded): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decodeValue)
  const tag = (value as { readonly '@'?: unknown })['@']
  if (typeof tag === 'string') {
    if (tag === 'repeat') {
      const unit = (value as { readonly unit?: unknown }).unit
      const count = (value as { readonly count?: unknown }).count
      if (typeof unit !== 'string' || typeof count !== 'number') {
        throw new TypeError('malformed repeat encoding')
      }
      return unit.repeat(count)
    }
    if (tag === 'buffer') {
      const base64 = (value as { readonly base64?: unknown }).base64
      if (typeof base64 !== 'string') throw new TypeError('malformed buffer encoding')
      return Buffer.from(base64, 'base64')
    }
    if (!SPECIALS.has(tag)) throw new TypeError(`unknown encoded tag: ${tag}`)
    return SPECIALS.get(tag)
  }
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) result[key] = decodeValue(item as Encoded)
  return result
}

export function sliceBlock (
  source: string, opening: string, closing: string, name: string
): string {
  const start = source.indexOf(opening)
  if (start < 0) throw new Error(`baseline index.js has no ${name} declaration`)
  const end = source.indexOf(closing, start)
  if (end < 0) throw new Error(`baseline ${name} declaration is unterminated`)
  return source.slice(start, end + closing.length)
}

// Reading the pinned commit rather than the working tree is the whole point: the captured
// declarations stop existing in `index.js` the moment the batch lands, and the capture must stay
// reproducible from history afterwards.
export function legacyIndexSource (commit: string): string {
  return execFileSync('git', ['show', `${commit}:index.js`], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024
  })
}

export function sourceSha256 (source: string): string {
  return createHash('sha256').update(source).digest('hex')
}

export interface FixtureDocument {
  readonly schemaVersion: 1
  readonly baselineCommit: string
  readonly baselineSha256: string
  readonly generator: string
  readonly sectionName: string
  readonly section: Readonly<Record<string, Encoded>>
  readonly rows: readonly unknown[]
}

// One line per row keeps the committed fixture inside the 64 KiB fixture budget while still giving
// a reviewable diff: a changed expectation shows up as exactly one changed line.
export function serializeFixture (document: FixtureDocument): string {
  const section = Object.entries(document.section)
    .map(([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)}`)
  return [
    '{',
    `  "schemaVersion": ${JSON.stringify(document.schemaVersion)},`,
    `  "baselineCommit": ${JSON.stringify(document.baselineCommit)},`,
    `  "baselineSha256": ${JSON.stringify(document.baselineSha256)},`,
    `  "generator": ${JSON.stringify(document.generator)},`,
    `  ${JSON.stringify(document.sectionName)}: {`,
    section.join(',\n'),
    '  },',
    '  "rows": [',
    document.rows.map(row => `    ${JSON.stringify(row)}`).join(',\n'),
    '  ]',
    '}',
    ''
  ].join('\n')
}

export function writeFixture (path: string, document: FixtureDocument): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serializeFixture(document), 'utf8')
  process.stdout.write(`${JSON.stringify(Object.freeze({
    fixture: path,
    baselineCommit: document.baselineCommit,
    baselineSha256: document.baselineSha256,
    [document.sectionName]: Object.keys(document.section).length,
    rows: document.rows.length
  }), null, 2)}\n`)
}
