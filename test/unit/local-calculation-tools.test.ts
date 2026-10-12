import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDateTimeTool } from '../../src/tools/DateTimeTool.js'
import { createUnitConvertTool } from '../../src/tools/UnitConvertTool.js'
import { parseDateTime } from '../../src/tools/local-date-time.js'
import { ToolRegistry } from '../../src/agent/tools/tool-registry.js'
import type { AuthorizedToolContext } from '../../src/agent/tools/tool-context.js'
import type { ToolResult } from '../../src/agent/tools/tool-result.js'

const context = { signal: new AbortController().signal } as AuthorizedToolContext
const dateInput = { operation: 'convert', value: '2026-10-12 08:00', other: '', timeZone: 'Asia/Shanghai', targetTimeZone: 'UTC', seconds: 0 }
function payload (result: ToolResult): any {
  assert.equal(result.status, 'success')
  if (result.status !== 'success' || result.content[0]?.type !== 'text') assert.fail('expected text')
  return JSON.parse(result.content[0].text)
}
test('local utilities register strict schemas and convert without network or a provider', async () => {
  const date = createDateTimeTool(() => Date.UTC(2026, 9, 12))
  const unit = createUnitConvertTool()
  new ToolRegistry([date, unit])
  assert.equal(date.network, 'none')
  assert.equal(unit.network, 'none')
  assert.equal(payload(await date.execute(dateInput, context)).utc, '2026-10-12T00:00:00.000Z')
  assert.equal(payload(await date.execute({ ...dateInput, operation: 'now' }, context)).local, '2026-10-12 00:00:00 [UTC]')
})
test('explicit offsets win over the source zone, including fractional-hour zones', () => {
  assert.equal(parseDateTime('2026-10-12T12:00:00+05:45', 'UTC'), Date.UTC(2026, 9, 12, 6, 15))
  assert.equal(parseDateTime('2026-10-12 12:00', 'Asia/Kathmandu'), Date.UTC(2026, 9, 12, 6, 15))
  assert.equal(parseDateTime('2026-10-12T00:00Z', 'Asia/Shanghai'), Date.UTC(2026, 9, 12))
  assert.equal(parseDateTime('2026-10-12T00:00:00.123Z', 'UTC'), Date.UTC(2026, 9, 12, 0, 0, 0, 123))
  assert.equal(parseDateTime('2026-10-12 08:00:00.1', 'Asia/Shanghai'), Date.UTC(2026, 9, 12, 0, 0, 0, 100))
})
test('DST repeated and nonexistent times require explicit offsets', () => {
  assert.throws(() => parseDateTime('2026-11-01 01:30', 'America/New_York'), /夏令时/)
  assert.throws(() => parseDateTime('2026-03-08 02:30', 'America/New_York'), /夏令时/)
  assert.equal(parseDateTime('2026-11-01T01:30:00-04:00', 'America/New_York'), Date.UTC(2026, 10, 1, 5, 30))
  assert.equal(parseDateTime('2026-11-01T01:30:00-05:00', 'America/New_York'), Date.UTC(2026, 10, 1, 6, 30))
})
test('invalid calendar dates, offsets and unsupported zones are rejected rather than normalized', async () => {
  for (const value of ['2026-02-29 12:00', '2026-04-31 12:00', '2026-10-12 24:00', '2026-10-12 12:00:60', 'tomorrow', '2026-10-12T12:00+14:01']) {
    assert.equal((await createDateTimeTool().execute({ ...dateInput, value }, context)).status, 'denied', value)
  }
  assert.equal((await createDateTimeTool().execute({ ...dateInput, timeZone: 'bad zone' }, context)).status, 'denied')
  assert.equal(parseDateTime('2028-02-29 12:00', 'UTC'), Date.UTC(2028, 1, 29, 12))
})
test('elapsed time arithmetic preserves DST elapsed duration and signed differences', async () => {
  const date = createDateTimeTool()
  const result = payload(await date.execute({ ...dateInput, operation: 'add', value: '2026-03-08 01:30', timeZone: 'America/New_York', targetTimeZone: 'America/New_York', seconds: 3600 }, context))
  assert.equal(result.local, '2026-03-08 03:30:00 [America/New_York]')
  assert.equal(payload(await date.execute({ ...dateInput, operation: 'difference', other: '2026-10-11T00:00:00Z' }, context)).seconds, -86400)
})
test('conversion uses affine temperatures, exact customary units and explicit SI/binary data units', async () => {
  const tool = createUnitConvertTool()
  for (const [value, from, to, expected] of [[32, 'F', 'C', 0], [0, 'C', 'K', 273.15], [1, 'mi', 'm', 1609.344], [1, 'lb', 'kg', .45359237], [1, 'MiB', 'B', 1048576], [1, 'MB', 'B', 1000000], [36, 'km/h', 'm/s', 10]] as const) {
    assert.ok(Math.abs(payload(await tool.execute({ value, from, to }, context)).result - expected) < 1e-9)
  }
})
test('different dimensions, unknown units, absolute-zero violations and overflow fail locally', async () => {
  const tool = createUnitConvertTool()
  for (const input of [{ value: 1, from: 'kg', to: 'm' }, { value: 1, from: '__proto__', to: 'm' },
    { value: -1, from: 'K', to: 'C' }, { value: Infinity, from: 'm', to: 'cm' }, { value: 1e308, from: 'km', to: 'mm' }]) {
    assert.equal((await tool.execute(input, context)).status, 'denied')
  }
})
