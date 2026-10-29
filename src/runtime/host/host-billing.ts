import { normalizedText, type HostConfigSource } from './host-config-values.js'
import type { BillingSnapshot, OpenAiBillingPort } from '../yunzai-chat-controller.js'

// The OpenAI dashboard billing endpoints are not part of the chat completions contract, so this
// stays on the host's own proxy-aware fetch rather than the model adapter.
export interface HostBillingDependencies {
  readonly config: HostConfigSource
  readonly fetch: (
    url: string, init: Readonly<{ method: string, headers: Readonly<Record<string, string>> }>
  ) => Promise<{ readonly ok: boolean, json: () => Promise<unknown> }>
}

const URL_CHARACTERS = 2_048
const USAGE_WINDOW_DAYS = 100

function formatDateOnly (date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-` +
    String(date.getDate()).padStart(2, '0')
}

function record (value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object'
    ? value as Readonly<Record<string, unknown>>
    : {}
}

export function createHostBilling (dependencies: HostBillingDependencies): OpenAiBillingPort {
  return Object.freeze({
    async queryLastHundredDays (now: Date): Promise<BillingSnapshot> {
      const config = dependencies.config
      const endpoint = normalizedText(config.openAiBaseUrl, URL_CHARACTERS).replace(/\/+$/, '')
      const headers = Object.freeze({ Authorization: `Bearer ${String(config.apiKey)}` })
      const subscriptionResponse = await dependencies.fetch(
        `${endpoint}/dashboard/billing/subscription`, { method: 'GET', headers }
      )
      if (!subscriptionResponse.ok) throw new Error('billing subscription request failed')
      const subscription = record(await subscriptionResponse.json())
      const end = new Date(now)
      end.setDate(end.getDate() + 1)
      const start = new Date(end)
      start.setDate(start.getDate() - USAGE_WINDOW_DAYS)
      const usageResponse = await dependencies.fetch(
        `${endpoint}/dashboard/billing/usage?start_date=${formatDateOnly(start)}&end_date=${formatDateOnly(end)}`,
        { method: 'GET', headers }
      )
      if (!usageResponse.ok) throw new Error('billing usage request failed')
      const usage = record(await usageResponse.json())
      const hardLimitUsd = Number(subscription.hard_limit_usd)
      const totalUsageUsd = Number(usage.total_usage) / 100
      const expiresAt = new Date(Number(subscription.access_until) * 1_000)
      if (!Number.isFinite(hardLimitUsd) || !Number.isFinite(totalUsageUsd) ||
        Number.isNaN(expiresAt.getTime())) throw new Error('billing response is invalid')
      return Object.freeze({ hardLimitUsd, totalUsageUsd, expiresAt })
    }
  })
}
