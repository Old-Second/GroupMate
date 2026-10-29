import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  YunzaiDiagnosticsController,
  type DiagnosticYunzaiEvent
} from '../../src/runtime/yunzai-diagnostics-controller.js'

function event (input: Partial<DiagnosticYunzaiEvent> = {}): {
  readonly value: DiagnosticYunzaiEvent
  readonly replies: string[]
} {
  const replies: string[] = []
  return {
    replies,
    value: Object.freeze({
      authorized: input.authorized ?? true,
      commandArgument: input.commandArgument ?? '',
      replyText: input.replyText ?? (async (text: string) => { replies.push(text) })
    })
  }
}

const unexpected = Object.freeze({
  status: async () => { throw new Error('unexpected status') },
  metricsReport: async () => { throw new Error('unexpected metrics') },
  usageReport: async () => { throw new Error('unexpected usage') },
  inspect: async () => { throw new Error('unexpected inspect') }
})

test('status delegates authorization and replies exactly once', async () => {
  const calls: boolean[] = []
  const controller = new YunzaiDiagnosticsController(Object.freeze({
    ...unexpected,
    status: async ({ authorized }: { readonly authorized: boolean }) => {
      calls.push(authorized)
      return Object.freeze({ schemaVersion: 1 as const, kind: 'status' as const, text: 'status' })
    }
  }))
  const current = event({ authorized: false })

  assert.equal(await controller.handleStatus(current.value), true)
  assert.deepEqual(calls, [false])
  assert.deepEqual(current.replies, ['status'])
})

test('each report command delegates authorization and replies exactly once', async () => {
  const calls: string[] = []
  const controller = new YunzaiDiagnosticsController(Object.freeze({
    ...unexpected,
    metricsReport: async ({ authorized }: { readonly authorized: boolean }) => {
      calls.push(`metrics:${authorized}`)
      return Object.freeze({ schemaVersion: 1 as const, kind: 'metrics' as const, text: 'm' })
    },
    usageReport: async ({ authorized }: { readonly authorized: boolean }) => {
      calls.push(`usage:${authorized}`)
      return Object.freeze({ schemaVersion: 1 as const, kind: 'usage' as const, text: 'u' })
    }
  }))
  const metrics = event({ authorized: false })
  const usage = event()

  assert.equal(await controller.handleMetrics(metrics.value), true)
  assert.equal(await controller.handleUsage(usage.value), true)
  assert.deepEqual(calls, ['metrics:false', 'usage:true'])
  assert.deepEqual(metrics.replies, ['m'])
  assert.deepEqual(usage.replies, ['u'])
})

test('inspect passes the unmodified command argument and replies exactly once', async () => {
  const calls: Array<{ authorized: boolean; runRef: string }> = []
  const controller = new YunzaiDiagnosticsController(Object.freeze({
    ...unexpected,
    inspect: async (input: { readonly authorized: boolean; readonly runRef: string }) => {
      calls.push(input)
      return Object.freeze({
        schemaVersion: 1 as const,
        kind: 'invalid_run_ref' as const,
        text: 'invalid'
      })
    }
  }))
  const current = event({ commandArgument: ' raw value ' })

  assert.equal(await controller.handleInspect(current.value), true)
  assert.deepEqual(calls, [{ authorized: true, runRef: ' raw value ' }])
  assert.deepEqual(current.replies, ['invalid'])
})
