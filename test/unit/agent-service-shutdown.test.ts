import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { bindYunzaiShutdownSignals } from '../../src/runtime/agent-service-bridge.js'

type ShutdownSignal = 'SIGINT' | 'SIGTERM'

class FakeProcessPort extends EventEmitter {
  readonly pid = 4_242
  readonly kills: Array<Readonly<{ pid: number; signal: ShutdownSignal }>> = []

  kill (pid: number, signal: ShutdownSignal): boolean {
    this.kills.push(Object.freeze({ pid, signal }))
    return true
  }
}

test('shutdown signal cancels GroupMate once before restoring default termination', async () => {
  const port = new FakeProcessPort()
  const reasons: string[] = []
  let finishShutdown: ((value: number) => void) | undefined
  const shutdownFinished = new Promise<number>(resolve => {
    finishShutdown = resolve
  })
  const release = bindYunzaiShutdownSignals({
    shutdown: async reason => {
      reasons.push(reason)
      return await shutdownFinished
    }
  }, port, 1_000)

  port.emit('SIGTERM')
  port.emit('SIGINT')
  assert.deepEqual(reasons, ['process_shutdown'])
  assert.deepEqual(port.kills, [])

  finishShutdown?.(1)
  await shutdownFinished
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(port.kills, [{ pid: 4_242, signal: 'SIGTERM' }])
  assert.equal(port.listenerCount('SIGINT'), 0)
  assert.equal(port.listenerCount('SIGTERM'), 0)
  release()
})

test('shutdown signal preserves a host-owned signal lifecycle', async () => {
  const port = new FakeProcessPort()
  let hostSignals = 0
  const reasons: string[] = []
  const release = bindYunzaiShutdownSignals({
    shutdown: async reason => {
      reasons.push(reason)
      return 0
    }
  }, port, 1_000)
  port.on('SIGTERM', () => { hostSignals += 1 })

  port.emit('SIGTERM')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(hostSignals, 1)
  assert.deepEqual(reasons, ['process_shutdown'])
  assert.deepEqual(port.kills, [])
  assert.equal(port.listenerCount('SIGTERM'), 1)
  release()
})

test('shutdown signal restores default termination after the bounded grace period', async () => {
  const port = new FakeProcessPort()
  const release = bindYunzaiShutdownSignals({
    shutdown: async () => await new Promise<number>(() => undefined)
  }, port, 5)

  port.emit('SIGINT')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(port.kills, [{ pid: 4_242, signal: 'SIGINT' }])
  assert.equal(port.listenerCount('SIGINT'), 0)
  assert.equal(port.listenerCount('SIGTERM'), 0)
  release()
})
