import { readResourceKeys } from '../agent/tools/resource-key.js';
import { boundedJson, invalidArguments, readOnlyDefinition, textResult } from './query-tool-support.js';
import { formatDateTime, parseDateTime, validateTimeZone } from './local-date-time.js';
export function createDateTimeTool(now = Date.now) {
    return readOnlyDefinition({
        name: 'dateTime', description: '纯本地日期/时区/时差计算。operation=now/convert/add/difference；value/other 为具体日期或带偏移 ISO，timeZone/targetTimeZone 为 IANA 时区（中国 Asia/Shanghai）。add 按 seconds 加减实际经过的秒数，不是日历月；difference=other-value。未用字符串填空，seconds 填0。夏令时歧义需要偏移，不能猜。',
        inputSchema: { type: 'object', properties: {
                operation: { type: 'string', enum: ['now', 'convert', 'add', 'difference'] },
                value: { type: 'string' }, other: { type: 'string' }, timeZone: { type: 'string' },
                targetTimeZone: { type: 'string' }, seconds: { type: 'number' }
            }, required: ['operation', 'value', 'other', 'timeZone', 'targetTimeZone', 'seconds'], additionalProperties: false },
        network: 'none', retrySafe: true, resourceKeys: input => readResourceKeys('dateTime', input),
        execute: async (input) => {
            try {
                const zone = validateTimeZone(input.timeZone);
                const target = validateTimeZone(input.targetTimeZone || zone);
                const start = input.operation === 'now' ? now() : parseDateTime(input.value, zone);
                if (input.operation === 'difference') {
                    const seconds = (parseDateTime(input.other, target) - start) / 1000;
                    return textResult(boundedJson({ seconds, minutes: seconds / 60, hours: seconds / 3600, days: seconds / 86400 }));
                }
                if (!['now', 'convert', 'add'].includes(String(input.operation)))
                    throw new TypeError('日期操作无效。');
                const amount = input.operation === 'add' ? input.seconds : 0;
                if (typeof amount !== 'number' || !Number.isFinite(amount) || Math.abs(amount) > 100 * 366 * 86400)
                    throw new TypeError('加减秒数须为有限数且不超过 100 年。');
                const timestamp = start + amount * 1000;
                const local = formatDateTime(timestamp, target);
                return textResult(boundedJson({ utc: new Date(timestamp).toISOString(), local, timeZone: target }));
            }
            catch (error) {
                return invalidArguments(error instanceof TypeError ? error.message : '日期计算失败。');
            }
        }
    });
}
