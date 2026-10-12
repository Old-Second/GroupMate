export function validateTimeZone(value) {
    if (typeof value !== 'string' || value.length > 80 || value.trim() === '')
        throw new TypeError('请使用 IANA 时区，例如 Asia/Shanghai。');
    try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format(0);
    }
    catch {
        throw new TypeError('时区无效，请使用 Asia/Shanghai、UTC 等 IANA 名称。');
    }
    return value;
}
function partsAt(timestamp, timeZone) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp);
    return ['year', 'month', 'day', 'hour', 'minute', 'second'].map(type => Number(parts.find(part => part.type === type)?.value));
}
/** Calendar validation precedes Date parsing; ambiguous/nonexistent DST wall times require an offset. */
export function parseDateTime(value, timeZone) {
    validateTimeZone(timeZone);
    if (typeof value !== 'string' || value.length > 80)
        throw new TypeError('日期须为 YYYY-MM-DD HH:mm[:ss] 或带偏移的 ISO 日期。');
    const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
    if (match === null)
        throw new TypeError('日期须含具体年月日和时间；相对日期请先换成具体日期。');
    const p = match.slice(1, 7).map(item => Number(item ?? 0));
    const [year, month, day, hour, minute, second] = p;
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 ||
        day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) {
        throw new TypeError('日期或时间超出范围（支持 2000～2100 年）。');
    }
    const milliseconds = Number((match[7] ?? '').padEnd(3, '0'));
    const wall = Date.UTC(year, month - 1, day, hour, minute, second, milliseconds);
    if (match[8] !== undefined) {
        const offset = match[8];
        if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4)) > 59 ||
            (Number(offset.slice(1, 3)) === 14 && Number(offset.slice(4)) !== 0)))
            throw new TypeError('UTC 偏移无效。');
        return Date.parse(`${value.replace(' ', 'T').slice(0, 16)}:${String(second).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}${offset}`);
    }
    const offsets = new Set();
    for (let delta = -36; delta <= 36; delta += 6) {
        const sample = Math.floor((wall + delta * 3600000) / 1000) * 1000;
        const local = partsAt(sample, timeZone);
        offsets.add(Date.UTC(local[0], local[1] - 1, local[2], local[3], local[4], local[5]) - sample);
    }
    const candidates = [...offsets].map(offset => wall - offset)
        .filter(timestamp => partsAt(timestamp, timeZone).every((part, index) => part === p[index]));
    if (candidates.length !== 1)
        throw new TypeError('该当地时间不存在或因夏令时出现两次；请提供带 UTC 偏移的 ISO 日期。');
    return candidates[0];
}
export function formatDateTime(timestamp, timeZone) {
    validateTimeZone(timeZone);
    if (!Number.isFinite(timestamp) || timestamp < Date.UTC(2000, 0, 1) || timestamp >= Date.UTC(2101, 0, 1))
        throw new TypeError('计算后的日期超出 2000～2100 年。');
    const parts = partsAt(timestamp, timeZone);
    return `${parts[0]}-${String(parts[1]).padStart(2, '0')}-${String(parts[2]).padStart(2, '0')} ${parts.slice(3).map(item => String(item).padStart(2, '0')).join(':')} [${timeZone}]`;
}
