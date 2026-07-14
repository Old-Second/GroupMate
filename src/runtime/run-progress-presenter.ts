import { createHash } from 'node:crypto'
import { parseAgentEvent, type AgentEvent } from '../agent/contracts/event.js'

export interface ProgressDeliveryFailure {
  readonly event: 'run.progress.delivery_failed'
  readonly runRef: string
  readonly sequence: number
  readonly eventType: string
}

export interface RunProgressPresenterOptions {
  readonly onDeliveryFailure?: (failure: ProgressDeliveryFailure) => void
}

export type ProgressDelivery = (text: string) => Promise<void>

interface ProgressState {
  delivery: ProgressDelivery
  readonly seenEventIds: Set<string>
  readonly seenStages: Set<string>
  attempts: number
  terminal: boolean
  queue: Promise<void>
}

const MAX_PROGRESS_MESSAGES = 5
const MAX_PROGRESS_CODE_POINTS = 200

const TOOL_PROGRESS: Readonly<Record<string, string>> = Object.freeze({
  website: '正在读取网页',
  weather: '正在查询天气',
  github: '正在查询 GitHub',
  queryUserinfo: '正在查询群成员信息',
  sendPicture: '正在处理图片',
  musicQuery: '正在查询音乐',
  videoQuery: '正在查询视频',
  imageCaption: '正在理解图片',
  imageSearch: '正在搜索图片',
  processPicture: '正在处理图片'
})

function runReference (runId: string): string {
  return createHash('sha256').update(runId).digest('hex').slice(0, 16)
}

function normalizedProgress (text: string): string {
  return [...text.normalize('NFC').trim()].slice(0, MAX_PROGRESS_CODE_POINTS).join('')
}

function progressFor (event: AgentEvent): Readonly<{ key: string; text: string }> | null {
  if (event.type !== 'tool.started' && event.type !== 'run.progress') return null
  if (event.type === 'run.progress' && event.payload.stage !== 'tool_started') return null
  const toolName = typeof event.payload.toolName === 'string' &&
    /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(event.payload.toolName)
    ? event.payload.toolName
    : 'unknown'
  const text = normalizedProgress(TOOL_PROGRESS[toolName] ?? '正在执行任务步骤')
  return text.length === 0 ? null : Object.freeze({
    key: `tool_started:${text}`,
    text
  })
}

function terminalEvent (event: AgentEvent): boolean {
  return event.type === 'run.completed' || event.type === 'run.failed' ||
    event.type === 'run.cancelled'
}

export class RunProgressPresenter {
  readonly #states = new Map<string, ProgressState>()
  readonly #onDeliveryFailure?: RunProgressPresenterOptions['onDeliveryFailure']

  constructor (options: RunProgressPresenterOptions = {}) {
    this.#onDeliveryFailure = options.onDeliveryFailure
  }

  attach (
    runId: string,
    delivery: ProgressDelivery,
    persistedEvents: readonly AgentEvent[] = []
  ): void {
    if (typeof runId !== 'string' || runId.length === 0 || runId.length > 128 ||
      typeof delivery !== 'function') {
      throw new TypeError('progress attachment is invalid')
    }
    const state = this.#states.get(runId) ?? {
      delivery,
      seenEventIds: new Set<string>(),
      seenStages: new Set<string>(),
      attempts: 0,
      terminal: false,
      queue: Promise.resolve()
    }
    state.delivery = delivery
    for (const rawEvent of persistedEvents) {
      let event: AgentEvent
      try {
        event = parseAgentEvent(rawEvent)
      } catch {
        continue
      }
      if (event.runId !== runId) continue
      state.seenEventIds.add(event.eventId)
      const progress = progressFor(event)
      if (progress !== null && !state.seenStages.has(progress.key)) {
        state.seenStages.add(progress.key)
        state.attempts += 1
      }
      if (terminalEvent(event)) state.terminal = true
    }
    this.#states.set(runId, state)
  }

  handle (rawEvent: AgentEvent): void {
    let event: AgentEvent
    try {
      event = parseAgentEvent(rawEvent)
    } catch {
      return
    }
    const state = this.#states.get(event.runId)
    if (state === undefined || state.seenEventIds.has(event.eventId)) return
    state.seenEventIds.add(event.eventId)
    if (terminalEvent(event)) {
      state.terminal = true
      return
    }
    if (state.terminal || state.attempts >= MAX_PROGRESS_MESSAGES) return
    const progress = progressFor(event)
    if (progress === null || state.seenStages.has(progress.key)) return
    state.seenStages.add(progress.key)
    state.attempts += 1
    const delivery = state.delivery
    state.queue = state.queue.then(async () => {
      try {
        await delivery(progress.text)
      } catch {
        this.#reportFailure(event)
      }
    })
  }

  async drain (runId: string): Promise<void> {
    await (this.#states.get(runId)?.queue ?? Promise.resolve())
  }

  detach (runId: string): void {
    this.#states.delete(runId)
  }

  #reportFailure (event: AgentEvent): void {
    try {
      this.#onDeliveryFailure?.(Object.freeze({
        event: 'run.progress.delivery_failed',
        runRef: runReference(event.runId),
        sequence: event.sequence,
        eventType: event.type
      }))
    } catch {
      // Logging cannot affect a run or another progress delivery.
    }
  }
}
