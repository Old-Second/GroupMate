import { normalizedText } from './host-config-values.js';
const URL_CHARACTERS = 2_048;
const USAGE_WINDOW_DAYS = 100;
function formatDateOnly(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-` +
        String(date.getDate()).padStart(2, '0');
}
function record(value) {
    return value !== null && typeof value === 'object'
        ? value
        : {};
}
export function createHostBilling(dependencies) {
    return Object.freeze({
        async queryLastHundredDays(now) {
            const config = dependencies.config;
            const endpoint = normalizedText(config.openAiBaseUrl, URL_CHARACTERS).replace(/\/+$/, '');
            const headers = Object.freeze({ Authorization: `Bearer ${String(config.apiKey)}` });
            const subscriptionResponse = await dependencies.fetch(`${endpoint}/dashboard/billing/subscription`, { method: 'GET', headers });
            if (!subscriptionResponse.ok)
                throw new Error('billing subscription request failed');
            const subscription = record(await subscriptionResponse.json());
            const end = new Date(now);
            end.setDate(end.getDate() + 1);
            const start = new Date(end);
            start.setDate(start.getDate() - USAGE_WINDOW_DAYS);
            const usageResponse = await dependencies.fetch(`${endpoint}/dashboard/billing/usage?start_date=${formatDateOnly(start)}&end_date=${formatDateOnly(end)}`, { method: 'GET', headers });
            if (!usageResponse.ok)
                throw new Error('billing usage request failed');
            const usage = record(await usageResponse.json());
            const hardLimitUsd = Number(subscription.hard_limit_usd);
            const totalUsageUsd = Number(usage.total_usage) / 100;
            const expiresAt = new Date(Number(subscription.access_until) * 1_000);
            if (!Number.isFinite(hardLimitUsd) || !Number.isFinite(totalUsageUsd) ||
                Number.isNaN(expiresAt.getTime()))
                throw new Error('billing response is invalid');
            return Object.freeze({ hardLimitUsd, totalUsageUsd, expiresAt });
        }
    });
}
