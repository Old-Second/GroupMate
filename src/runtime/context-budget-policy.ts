/**
 * Turns a model's declared context window into the budget one request may use.
 *
 * The window from the provider profile (or the user override) is a capability,
 * not a promise the plugin can send that many bytes: the request body has its
 * own hard ceiling. The budget is therefore the smaller of the two, expressed
 * in the same `bytes / 4` unit the context planner uses for token estimates.
 *
 * Keeping this derivation in one place means the run planner
 * (`run-context-planner.ts`) and the context engine (`ContextEngine.prepare`)
 * cannot drift apart: both read the same frozen capability snapshot.
 */

import { MAX_CONTEXT_SPANS } from '../agent/context/context-span.js'
import type { ContextBudget } from '../agent/context/context-budget.js'
import { RUN_RESOURCE_LIMITS } from '../agent/run/run-limits.js'

/** Token estimate used across the planner: one token per four UTF-8 bytes. */
export const CONTEXT_BYTES_PER_TOKEN = 4

/** Room for model name, tools, metadata and JSON punctuation around the items. */
export const CONTEXT_REQUEST_ENVELOPE_BYTES = 512 * 1_024

/** Tool schemas are a fixed cost that does not grow with the window. */
export const DEFAULT_RESERVED_TOOL_TOKENS = 4_096

export const DEFAULT_SAFETY_MARGIN_TOKENS = 1_024

/** The smallest input a request may keep after reservations. */
export const MIN_CONTEXT_INPUT_TOKENS = 1_024

export interface ContextBudgetInput {
  readonly contextWindowTokens: number
  readonly maxOutputTokens: number
  readonly maxRequestBytes?: number
}

function safePositiveInteger (value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`)
  }
  return value
}

/**
 * Derives the request budget from the declared window and the request ceiling.
 *
 * Reservations shrink with tiny windows so a small model still gets a usable
 * input allowance instead of failing every request: the output reservation is
 * capped at whatever is left after the tool and safety reserves.
 */
export function deriveContextBudget (input: ContextBudgetInput): ContextBudget {
  const window = safePositiveInteger(input.contextWindowTokens, 'context window')
  const maxOutputTokens = Number.isSafeInteger(input.maxOutputTokens) && input.maxOutputTokens >= 0
    ? input.maxOutputTokens
    : 0
  const requestBytes = safePositiveInteger(
    input.maxRequestBytes ?? RUN_RESOURCE_LIMITS.requestBytes,
    'request bytes'
  )
  const usableBytes = Math.max(1, requestBytes - CONTEXT_REQUEST_ENVELOPE_BYTES)
  const bytesLimitedTokens = Math.floor(usableBytes / CONTEXT_BYTES_PER_TOKEN)
  const modelContextTokens = Math.max(1, Math.min(window, bytesLimitedTokens))
  const reservedToolTokens = Math.min(
    DEFAULT_RESERVED_TOOL_TOKENS,
    Math.floor(modelContextTokens / 8)
  )
  const safetyMarginTokens = Math.min(
    DEFAULT_SAFETY_MARGIN_TOKENS,
    Math.floor(modelContextTokens / 16)
  )
  const reservedOutputTokens = Math.min(
    maxOutputTokens,
    Math.max(0, modelContextTokens - reservedToolTokens - safetyMarginTokens - MIN_CONTEXT_INPUT_TOKENS)
  )
  return Object.freeze({
    modelContextTokens,
    reservedOutputTokens,
    reservedToolTokens,
    safetyMarginTokens,
    maxItems: MAX_CONTEXT_SPANS,
    maxBytes: usableBytes
  })
}

/** Input tokens one request may actually fill after every reservation. */
export function availableInputTokens (budget: ContextBudget): number {
  return budget.modelContextTokens - budget.reservedOutputTokens -
    budget.reservedToolTokens - budget.safetyMarginTokens
}
