import { types as utilTypes } from 'node:util'
import { invalidMemoryValue } from './memory-namespace.js'

export interface MemoryPortSignalScopeV1 {
  readonly signal: AbortSignal | undefined
  readonly isAborted: () => boolean
  readonly close: () => void
}

const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted'
)?.get
const eventTargetAddEventListener = EventTarget.prototype.addEventListener
const eventTargetRemoveEventListener = EventTarget.prototype.removeEventListener

function nativeSignalContainerPrototype (description: 'kEvents' | 'kHandlers'): object | null {
  const signal = new AbortController().signal
  const key = Reflect.ownKeys(signal).find(value => (
    typeof value === 'symbol' && value.description === description
  ))
  if (key === undefined) return invalidMemoryValue()
  const descriptor = Object.getOwnPropertyDescriptor(signal, key)
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
    descriptor.value === null || typeof descriptor.value !== 'object' ||
    utilTypes.isProxy(descriptor.value)) return invalidMemoryValue()
  return Object.getPrototypeOf(descriptor.value) as object | null
}

const nativeEventsPrototype = nativeSignalContainerPrototype('kEvents')
const nativeHandlersPrototype = nativeSignalContainerPrototype('kHandlers')

function nativeSignalSetPrototype (): object | null {
  const source = new AbortController()
  const composite = AbortSignal.any([source.signal])
  const prototypes = [
    [composite, 'kSourceSignals'],
    [source.signal, 'kDependantSignals']
  ] as const
  let expected: object | null | undefined
  for (const [signal, description] of prototypes) {
    const key = Reflect.ownKeys(signal).find(value => (
      typeof value === 'symbol' && value.description === description
    ))
    if (key === undefined) return invalidMemoryValue()
    const descriptor = Object.getOwnPropertyDescriptor(signal, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') ||
      descriptor.value === null || typeof descriptor.value !== 'object' ||
      utilTypes.isProxy(descriptor.value) || Reflect.ownKeys(descriptor.value).length !== 0) {
      return invalidMemoryValue()
    }
    const prototype = Object.getPrototypeOf(descriptor.value) as object | null
    if (expected !== undefined && prototype !== expected) return invalidMemoryValue()
    expected = prototype
  }
  if (expected === undefined) return invalidMemoryValue()
  return expected
}

const nativeSignalSetContainerPrototype = nativeSignalSetPrototype()

function nativeSignalAborted (signal: AbortSignal): boolean {
  if (typeof abortSignalAbortedGetter !== 'function') return invalidMemoryValue()
  try {
    return Reflect.apply(abortSignalAbortedGetter, signal, []) === true
  } catch {
    return invalidMemoryValue()
  }
}

function parseNativeAbortSignal (value: unknown): AbortSignal | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) {
    return invalidMemoryValue()
  }
  let prototype: object | null
  let keys: readonly PropertyKey[]
  try {
    prototype = Object.getPrototypeOf(value) as object | null
    keys = Reflect.ownKeys(value)
  } catch {
    return invalidMemoryValue()
  }
  if (prototype !== AbortSignal.prototype || keys.some(key => typeof key === 'string')) {
    return invalidMemoryValue()
  }
  let foundAbortedSlot = false
  let foundEventsSlot = false
  let foundHandlersSlot = false
  let foundSourceSignalsSlot = false
  let foundDependantSignalsSlot = false
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
      return invalidMemoryValue()
    }
    if (typeof key !== 'symbol') return invalidMemoryValue()
    if (key.description === 'kAborted') {
      if (foundAbortedSlot || typeof descriptor.value !== 'boolean') {
        return invalidMemoryValue()
      }
      foundAbortedSlot = true
      continue
    }
    if (key.description === 'kEvents' || key.description === 'kHandlers') {
      const expectedPrototype = key.description === 'kEvents'
        ? nativeEventsPrototype
        : nativeHandlersPrototype
      const alreadyFound = key.description === 'kEvents' ? foundEventsSlot : foundHandlersSlot
      const container = descriptor.value
      if (alreadyFound || container === null || typeof container !== 'object' ||
        utilTypes.isProxy(container)) return invalidMemoryValue()
      let containerPrototype: object | null
      let containerKeys: readonly PropertyKey[]
      try {
        containerPrototype = Object.getPrototypeOf(container) as object | null
        containerKeys = Reflect.ownKeys(container)
      } catch {
        return invalidMemoryValue()
      }
      if (containerPrototype !== expectedPrototype || containerKeys.length !== 0) {
        return invalidMemoryValue()
      }
      if (key.description === 'kEvents') foundEventsSlot = true
      else foundHandlersSlot = true
      continue
    }
    if (key.description === 'kSourceSignals' || key.description === 'kDependantSignals') {
      const alreadyFound = key.description === 'kSourceSignals'
        ? foundSourceSignalsSlot
        : foundDependantSignalsSlot
      const container = descriptor.value
      if (alreadyFound || container === null || typeof container !== 'object' ||
        utilTypes.isProxy(container)) return invalidMemoryValue()
      let containerPrototype: object | null
      let containerKeys: readonly PropertyKey[]
      try {
        containerPrototype = Object.getPrototypeOf(container) as object | null
        containerKeys = Reflect.ownKeys(container)
      } catch {
        return invalidMemoryValue()
      }
      if (containerPrototype !== nativeSignalSetContainerPrototype || containerKeys.length !== 0) {
        return invalidMemoryValue()
      }
      if (key.description === 'kSourceSignals') foundSourceSignalsSlot = true
      else foundDependantSignalsSlot = true
      continue
    }
    if (key.description === 'kReason') {
      if (utilTypes.isProxy(descriptor.value)) return invalidMemoryValue()
      continue
    }
    if (descriptor.value !== null &&
      (typeof descriptor.value === 'object' || typeof descriptor.value === 'function')) {
      return invalidMemoryValue()
    }
  }
  if (!foundAbortedSlot || !foundEventsSlot || !foundHandlersSlot) return invalidMemoryValue()
  nativeSignalAborted(value as AbortSignal)
  return value as AbortSignal
}

export function createMemoryPortSignalScopeV1 (
  value: unknown
): MemoryPortSignalScopeV1 {
  const source = parseNativeAbortSignal(value)
  if (source === undefined) {
    return Object.freeze({
      signal: undefined,
      isAborted: () => false,
      close: () => undefined
    })
  }

  const controller = new AbortController()
  let aborted = false
  let listening = false
  const abort = (): void => {
    if (aborted) return
    aborted = true
    controller.abort()
  }

  if (nativeSignalAborted(source)) {
    abort()
  } else {
    try {
      Reflect.apply(eventTargetAddEventListener, source, ['abort', abort, { once: true }])
      listening = true
    } catch {
      return invalidMemoryValue()
    }
    if (nativeSignalAborted(source)) abort()
  }

  const close = (): void => {
    if (!listening) return
    listening = false
    try {
      Reflect.apply(eventTargetRemoveEventListener, source, ['abort', abort])
    } catch {
      // The source was validated before listener registration. Cleanup failure is non-authoritative.
    }
  }

  return Object.freeze({
    signal: controller.signal,
    isAborted: () => aborted,
    close
  })
}
