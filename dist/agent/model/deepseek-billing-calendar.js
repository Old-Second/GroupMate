/**
 * Pricing: https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 * 2026 calendar: https://www.gov.cn/zhengce/content/202511/content_7047090.htm
 * Weekends stay off-peak even on an adjusted working day: the price rule says
 * Monday-Friday, excluding public holidays, rather than the workday calendar.
 * Unknown years fail closed; do not silently extrapolate lunar holidays.
 */
const HOLIDAYS_2026 = Object.freeze([
    ['01-01', '01-03'], ['02-15', '02-23'], ['04-04', '04-06'],
    ['05-01', '05-05'], ['06-19', '06-21'], ['09-25', '09-27'], ['10-01', '10-07']
]);
export function deepSeekBillingPeriod(instant) {
    if (!Number.isFinite(instant.getTime()))
        throw new TypeError('billing instant is invalid');
    const beijing = new Date(instant.getTime() + 8 * 3_600_000);
    if (beijing.getUTCFullYear() !== 2026)
        return undefined;
    const day = beijing.getUTCDay();
    const date = beijing.toISOString().slice(5, 10);
    const holiday = HOLIDAYS_2026.some(([start, end]) => date >= start && date <= end);
    const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
    return day >= 1 && day <= 5 && !holiday &&
        ((minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60))
        ? 'peak' : 'offpeak';
}
