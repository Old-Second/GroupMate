// Batch 2 of the `index.js` host-bootstrap migration: the bot registry (remembered-bot table,
// account identity resolution, bot picker, host master list, event actor and event target).
//
// The legacy declarations are sliced out of a pinned `index.js` and executed for real. Two parts of
// the host surface cannot be reached from a sliced function on its own and are therefore supplied
// the way the host supplies them: `globalThis.Bot` is installed around each call and restored after
// it, and the Yunzai host config module is written to a temporary ESM file whose URL replaces the
// `'../../lib/config/config.js'` specifier. The `await import(...)` expression itself still runs.
//
// `normalizedText` is injected from the typed batch-1 module rather than re-sliced: batch 1 already
// holds it to 169 captured legacy rows, so both sides of this batch share a proven primitive.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizedText } from '../runtime/host/host-config-values.js';
import { encodeValue, legacyIndexSource, sliceBlock, sourceSha256, writeFixture } from './host-bootstrap-fixture.js';
export const BASELINE_COMMIT = '5bf84e2c05f43c118f28ca0d21480a0474708203';
export const FIXTURE_PATH = 'test/fixtures/host-bootstrap/batch-2-bot-registry.json';
const HOST_CONFIG_SPECIFIER = "'../../lib/config/config.js'";
const REMEMBERED_BOTS_DECLARATION = 'const rememberedBots = new Map()';
export const HOST_BOTS = Object.freeze({
    absent: undefined,
    nonObject: 'not-a-bot',
    scalarUin: Object.freeze({
        uin: '10001',
        10001: Object.freeze({ uin: '10001', label: 'indexed-10001' })
    }),
    numericUin: Object.freeze({ uin: 10_001 }),
    nullUin: Object.freeze({ uin: null }),
    arrayUin: Object.freeze({
        uin: Object.freeze(['10001', '10002', '10003']),
        10002: Object.freeze({ uin: '10002', label: 'indexed-10002' })
    }),
    arrayUinWithHoles: Object.freeze({ uin: Object.freeze(['10001', null, undefined]) }),
    // A configured TRSS account of `0` matches a real candidate here, which is the only shape that
    // can tell the legacy truthiness test apart from a presence test.
    zeroUin: Object.freeze({ uin: Object.freeze(['0', '10001']) }),
    emptyArrayUin: Object.freeze({ uin: Object.freeze([]) })
});
export const CONFIGS = Object.freeze({
    empty: Object.freeze({}),
    matchingTrss: Object.freeze({ trssBotUin: '10002' }),
    unmatchedTrss: Object.freeze({ trssBotUin: '99999' }),
    numericTrss: Object.freeze({ trssBotUin: 10_001 }),
    blankTrss: Object.freeze({ trssBotUin: '' }),
    zeroTrss: Object.freeze({ trssBotUin: 0 })
});
export const HOST_CONFIGS = Object.freeze({
    missing: undefined,
    nonObject: 'nope',
    absentField: Object.freeze({}),
    nullField: Object.freeze({ masterQQ: null }),
    scalar: Object.freeze({ masterQQ: 1_001 }),
    stringList: Object.freeze({ masterQQ: Object.freeze(['1001', '1002']) }),
    mixedList: Object.freeze({
        masterQQ: Object.freeze(['1001', 1_002, null, true, Object.freeze({})])
    })
});
const LONG_ID = 'a'.repeat(200);
// Events that carry their own account identity: the host bot object never decides the answer.
export const IDENTITY_EVENTS = Object.freeze([
    Object.freeze({ self_id: '20001' }),
    Object.freeze({ self_id: 0 }),
    Object.freeze({ self_id: '  20004  ' }),
    Object.freeze({ self_id: LONG_ID }),
    Object.freeze({ self_id: '', bot: Object.freeze({ uin: '20002' }) }),
    Object.freeze({ bot: Object.freeze({ uin: '20003' }) }),
    Object.freeze({ bot: Object.freeze({ uin: 0 }) }),
    Object.freeze({
        isGroup: true, group_id: 777, sender: Object.freeze({ user_id: 555 }), self_id: '20005'
    }),
    Object.freeze({ isGroup: true, group_id: '', user_id: '556', self_id: '20006' }),
    Object.freeze({ isGroup: 'true', group_id: '778', user_id: '557', self_id: '20007' }),
    Object.freeze({ isGroup: false, sender: Object.freeze({ user_id: 0 }), self_id: '20008' }),
    Object.freeze({ user_id: '  558  ', self_id: '20009' }),
    Object.freeze({ sender: 'primitive-sender', user_id: '559', self_id: '20010' }),
    // `sender.user_id` wins over the top-level `user_id`; only an event carrying both can show it.
    Object.freeze({
        sender: Object.freeze({ user_id: '561' }), user_id: '562', self_id: '20012'
    }),
    Object.freeze({
        isGroup: true, sender: Object.freeze({ user_id: '563' }), user_id: '564',
        group_id: '780', self_id: '20013'
    }),
    Object.freeze({
        isGroup: true, group_id: LONG_ID, sender: Object.freeze({ user_id: LONG_ID }),
        self_id: '20011'
    })
]);
// Events with no usable account identity: these are the only ones that reach `globalThis.Bot`.
export const FALLBACK_EVENTS = Object.freeze([
    undefined,
    null,
    42,
    Object.freeze({}),
    Object.freeze({ self_id: '' }),
    Object.freeze({ self_id: null, bot: 'primitive-bot' }),
    Object.freeze({ isGroup: true, group_id: '779', sender: Object.freeze({ user_id: '560' }) })
]);
export const EVENTS = Object.freeze([...IDENTITY_EVENTS, ...FALLBACK_EVENTS]);
// `rememberBot` is an eight-slot table with insertion-order eviction, and re-remembering an id has
// to move it back to the newest slot. Only a sequence can observe either property.
export const SEQUENCES = Object.freeze({
    evictsOldestBeyondEight: Object.freeze([
        ...Array.from({ length: 10 }, (_, index) => `remember:b${index}`),
        ...Array.from({ length: 10 }, (_, index) => `pick:b${index}`)
    ]),
    refreshKeepsRecentlyUsed: Object.freeze([
        ...Array.from({ length: 8 }, (_, index) => `remember:c${index}`),
        'remember:c0', 'remember:c8',
        'pick:c0', 'pick:c1', 'pick:c8'
    ]),
    rejectsNonObjectsAndBlankIds: Object.freeze([
        'rememberPrimitive:d0', 'rememberNull:d1', 'rememberBlank:d2',
        'pick:d0', 'pick:d1', 'pick:'
    ]),
    identityResolutionRemembersEventBot: Object.freeze([
        'identify:{"self_id":"30001","bot":{"uin":"30001","label":"from-event"}}',
        'pick:30001',
        'identify:{"self_id":"30002"}',
        'pick:30002',
        'identify:{"self_id":"10001"}',
        'pick:10001'
    ])
});
// Bot objects are host handles, not data: identity is what the row has to pin, so a remembered bot
// travels as its label and an unexpected object as its key list.
function describe(value) {
    if (value === null || typeof value !== 'object')
        return encodeValue(value);
    const label = value.label;
    return typeof label === 'string'
        ? { '@': 'bot', label }
        : { '@': 'bot', keys: Object.keys(value).sort() };
}
async function runSequence(api, steps) {
    const outcomes = [];
    for (const step of steps) {
        const separator = step.indexOf(':');
        const action = step.slice(0, separator);
        const argument = step.slice(separator + 1);
        if (action === 'remember') {
            api.rememberBot(argument, { label: `bot-${argument}` });
            continue;
        }
        if (action === 'rememberPrimitive') {
            api.rememberBot(argument, `primitive-${argument}`);
            continue;
        }
        if (action === 'rememberNull') {
            api.rememberBot(argument, null);
            continue;
        }
        if (action === 'rememberBlank') {
            api.rememberBot('', { label: `bot-${argument}` });
            continue;
        }
        if (action === 'identify') {
            try {
                outcomes.push({ identified: api.configuredBotId(JSON.parse(argument)) });
            }
            catch (error) {
                outcomes.push(encodeValue(error));
            }
            continue;
        }
        if (action !== 'pick')
            throw new Error(`unknown sequence action: ${action}`);
        outcomes.push({ picked: argument, bot: describe(await api.botPicker.pick(argument)) });
    }
    return outcomes;
}
export async function runCase(api, fn, args) {
    let result;
    try {
        if (fn === 'configuredBotId')
            result = api.configuredBotId(args[0]);
        else if (fn === 'eventActorId')
            result = api.eventActorId(args[0]);
        else if (fn === 'eventTarget')
            result = api.eventTarget(args[0]);
        else if (fn === 'masterIds')
            result = await api.masterIds();
        else if (fn === 'botPicker.pick')
            result = describe(await api.botPicker.pick(String(args[0])));
        else if (fn === 'sequence')
            result = await runSequence(api, SEQUENCES[String(args[0])]);
        else
            throw new Error(`no caller for ${fn}`);
    }
    catch (error) {
        result = error;
    }
    return Object.freeze({
        result,
        frozen: result !== null && typeof result === 'object' ? Object.isFrozen(result) : null
    });
}
// The legacy helpers read `globalThis.Bot` synchronously before any `await`, so installing the host
// object for the duration of the synchronous call and restoring it afterwards reproduces what the
// Yunzai process does without leaving a global behind.
function withHostBot(hostBot, call) {
    const host = globalThis;
    const had = Object.hasOwn(host, 'Bot');
    const previous = host.Bot;
    if (hostBot === undefined)
        delete host.Bot;
    else
        host.Bot = hostBot;
    try {
        return call();
    }
    finally {
        if (had)
            host.Bot = previous;
        else
            delete host.Bot;
    }
}
const FUNCTION_SLICES = Object.freeze(['rememberBot', 'configuredBotId', 'eventActorId', 'eventTarget']);
export function legacyBotRegistry(source, config, hostBot, hostConfigModuleUrl) {
    if (!source.includes(`\n${REMEMBERED_BOTS_DECLARATION}\n`)) {
        throw new Error('baseline index.js has no rememberedBots declaration');
    }
    const blocks = [
        REMEMBERED_BOTS_DECLARATION,
        ...FUNCTION_SLICES.map(name => sliceBlock(source, `\nfunction ${name} (`, '\n}\n', name)),
        sliceBlock(source, '\nasync function masterIds (', '\n}\n', 'masterIds'),
        sliceBlock(source, '\nconst botPicker = Object.freeze({', '\n})\n', 'botPicker')
    ];
    const body = blocks.join('\n').replace(HOST_CONFIG_SPECIFIER, JSON.stringify(hostConfigModuleUrl));
    if (body.includes(HOST_CONFIG_SPECIFIER)) {
        throw new Error('the host config specifier was not substituted');
    }
    const factory = new Function('Config', 'normalizedText', `${body}\nreturn { rememberBot, configuredBotId, botPicker, masterIds, eventActorId, eventTarget }`);
    const api = factory(config, normalizedText);
    return Object.freeze({
        rememberBot: (botId, bot) => withHostBot(hostBot, () => api.rememberBot(botId, bot)),
        configuredBotId: (event) => withHostBot(hostBot, () => api.configuredBotId(event)),
        botPicker: Object.freeze({
            pick: async (botId) => await withHostBot(hostBot, () => api.botPicker.pick(botId))
        }),
        masterIds: async () => await api.masterIds(),
        eventActorId: (event) => withHostBot(hostBot, () => api.eventActorId(event)),
        eventTarget: (event) => withHostBot(hostBot, () => api.eventTarget(event))
    });
}
function hostConfigModules() {
    const directory = mkdtempSync(join(tmpdir(), 'groupmate-host-config-'));
    const urls = {};
    for (const [name, value] of Object.entries(HOST_CONFIGS)) {
        const file = join(directory, `${name}.mjs`);
        writeFileSync(file, `export default ${value === undefined ? 'undefined' : JSON.stringify(value)}\n`, 'utf8');
        urls[name] = pathToFileURL(file).href;
    }
    return Object.freeze({ directory, urls: Object.freeze(urls) });
}
async function row(api, fn, labels, args) {
    const { result, frozen } = await runCase(api, fn, args);
    return Object.freeze({
        fn,
        hostBot: labels.hostBot ?? null,
        config: labels.config ?? null,
        hostConfig: labels.hostConfig ?? null,
        args: Object.freeze(args.map(encodeValue)),
        result: encodeValue(result),
        frozen
    });
}
export async function buildRowsWith(create) {
    const rows = [];
    for (const event of EVENTS) {
        const labels = { hostBot: 'scalarUin', config: 'empty' };
        const api = create(CONFIGS.empty, HOST_BOTS.scalarUin, 'missing');
        rows.push(await row(api, 'configuredBotId', labels, [event]));
        rows.push(await row(api, 'eventActorId', {}, [event]));
        rows.push(await row(api, 'eventTarget', labels, [event]));
    }
    // Identity-bearing events never read `globalThis.Bot`, so only the fallback case is worth
    // crossing against the whole host matrix.
    for (const [hostBotName, hostBot] of Object.entries(HOST_BOTS)) {
        for (const [configName, config] of Object.entries(CONFIGS)) {
            rows.push(await row(create(config, hostBot, 'missing'), 'configuredBotId', { hostBot: hostBotName, config: configName }, [Object.freeze({})]));
        }
        const api = create(CONFIGS.empty, hostBot, 'missing');
        for (const botId of ['10001', '10002', '10003', '']) {
            rows.push(await row(api, 'botPicker.pick', { hostBot: hostBotName }, [botId]));
        }
    }
    for (const name of Object.keys(HOST_CONFIGS)) {
        rows.push(await row(create(CONFIGS.empty, HOST_BOTS.absent, name), 'masterIds', { hostConfig: name }, []));
    }
    for (const name of Object.keys(SEQUENCES)) {
        rows.push(await row(create(CONFIGS.empty, HOST_BOTS.scalarUin, 'missing'), 'sequence', { hostBot: 'scalarUin' }, [name]));
    }
    return Object.freeze(rows);
}
export async function buildRows(source) {
    const modules = hostConfigModules();
    try {
        return await buildRowsWith((config, hostBot, hostConfig) => legacyBotRegistry(source, config, hostBot, modules.urls[hostConfig]));
    }
    finally {
        rmSync(modules.directory, { recursive: true, force: true });
    }
}
export async function captureBaseline(source) {
    return Object.freeze({
        schemaVersion: 1,
        baselineCommit: BASELINE_COMMIT,
        baselineSha256: sourceSha256(source),
        generator: 'src/verification/host-bot-registry-baseline.ts',
        sectionName: 'scenarios',
        section: Object.freeze({
            hostBots: encodeValue(HOST_BOTS),
            configs: encodeValue(CONFIGS),
            hostConfigs: encodeValue(HOST_CONFIGS),
            events: encodeValue(EVENTS),
            sequences: encodeValue(SEQUENCES)
        }),
        rows: await buildRows(source)
    });
}
export async function main() {
    writeFixture(FIXTURE_PATH, await captureBaseline(legacyIndexSource(BASELINE_COMMIT)));
}
