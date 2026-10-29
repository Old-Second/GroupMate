import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { materializeYunzaiMagicSegment } from '../../src/runtime/presentation/yunzai-magic-segment.js'

test('Yunzai magic segment materializer delegates to native factories with their receiver and arguments', () => {
  const calls: string[] = []
  const dice = Object.freeze({ native: 'dice' })
  const rps = Object.freeze({ native: 'rps' })
  const segment = {
    marker: 'native-segment',
    dice (this: { marker: string }) {
      calls.push(`dice:${this.marker}`)
      return dice
    },
    rps (this: { marker: string }, value: number) {
      calls.push(`rps:${this.marker}:${String(value)}`)
      return rps
    }
  }

  assert.equal(materializeYunzaiMagicSegment(segment, 'dice'), dice)
  assert.equal(materializeYunzaiMagicSegment(segment, 'rps', 2), rps)
  assert.deepEqual(calls, [
    'dice:native-segment',
    'rps:native-segment:2'
  ])
})

test('Yunzai magic segment materializer falls back to standard OneBot v11 segments', () => {
  assert.deepEqual(materializeYunzaiMagicSegment({}, 'dice'), {
    type: 'dice',
    data: {}
  })
  assert.deepEqual(materializeYunzaiMagicSegment({}, 'rps', 3), {
    type: 'rps',
    data: {}
  })
})

test('all production Yunzai outbound paths share the typed magic segment materializer', async () => {
  // The entry point used to own outbound materialization; it now binds the host globals to
  // `src/runtime/host/host-outbound.ts`, so that module is this check's production root. The
  // assertions on the dice and rps call sites are unchanged.
  const [entry, outbound, serviceBridge, toolRuntime] = await Promise.all([
    readFile(join(process.cwd(), 'index.js'), 'utf8'),
    readFile(join(process.cwd(), 'src/runtime/host/host-outbound.ts'), 'utf8'),
    readFile(join(process.cwd(), 'src/runtime/agent-service-bridge.ts'), 'utf8'),
    readFile(join(process.cwd(), 'src/runtime/tools/yunzai-tool-runtime.ts'), 'utf8')
  ])

  assert.match(
    entry,
    /from '\.\/dist\/runtime\/host\/host-outbound\.js'/
  )
  assert.doesNotMatch(
    entry,
    /yunzai-magic-segment\.js/
  )
  assert.match(
    outbound,
    /from '\.\.\/presentation\/yunzai-magic-segment\.js'/
  )
  assert.match(
    serviceBridge,
    /from '\.\/presentation\/yunzai-magic-segment\.js'/
  )
  assert.match(
    toolRuntime,
    /from '\.\.\/presentation\/yunzai-magic-segment\.js'/
  )

  for (const source of [outbound, serviceBridge, toolRuntime]) {
    assert.match(
      source,
      /part\.media === 'dice'\) return materializeYunzaiMagicSegment\(segment, 'dice'\)/
    )
    assert.match(
      source,
      /part\.media === 'rps'\) return materializeYunzaiMagicSegment\(segment, 'rps', part\.value\)/
    )
    assert.doesNotMatch(source, /return \{ type: 'dice' \}/)
    assert.doesNotMatch(source, /return \{ type: 'rps', value: part\.value \}/)
  }
  assert.doesNotMatch(toolRuntime, /function magicSegment\s*\(/)
})
