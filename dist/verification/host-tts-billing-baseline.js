// Batch 5 of the `index.js` host-bootstrap migration: TTS administration (mode, configuration
// checks, voice selection across the three backends, missing-configuration copy) and the OpenAI
// dashboard billing query.
//
// The legacy declarations are sliced out of a pinned `index.js` and executed for real. The three
// speaker catalogues, the alias resolver and the proxy-aware fetch live outside the typed layer, so
// they arrive as fixture tables and a recording stub: a billing row therefore pins the exact URLs,
// method and header shape the query produced.
import { normalizedText } from '../runtime/host/host-config-values.js';
import { resolveTtsMode } from '../runtime/host/host-config-projection.js';
import { encodeValue, legacyIndexSource, sliceBlock, sourceSha256, writeFixture } from './host-bootstrap-fixture.js';
export const BASELINE_COMMIT = '5bf84e2c05f43c118f28ca0d21480a0474708203';
export const FIXTURE_PATH = 'test/fixtures/host-bootstrap/batch-5-tts-billing.json';
export const VITS_SPEAKERS = Object.freeze(['纳西妲', '胡桃', '钟离', '派蒙']);
// `convertSpeaker` resolves nicknames to catalogue names and returns its input unchanged when it
// knows no alias; the fixture keeps one alias so that branch is reachable.
export const VITS_ALIASES = Object.freeze({ 草神: '纳西妲', 火胡: '胡桃' });
export const AZURE_VOICES = Object.freeze([
    Object.freeze({
        code: 'zh-CN-XiaochenNeural', name: '晓辰', gender: '女', languageDetail: '中文（普通话）'
    }),
    Object.freeze({
        code: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: '女', languageDetail: '中文（普通话）',
        emotion: Object.freeze(['general', 'cheerful'])
    }),
    Object.freeze({
        code: 'en-US-JennyNeural', name: 'Jenny', gender: '女', languageDetail: 'English (US)',
        emotion: Object.freeze(['general'])
    })
]);
export const VOICEVOX_VOICES = Object.freeze([
    Object.freeze({
        name: '护士机器子T',
        styles: Object.freeze([Object.freeze({ name: 'ノーマル' })])
    }),
    Object.freeze({
        name: '四国めたん',
        styles: Object.freeze([
            Object.freeze({ name: 'ノーマル' }),
            Object.freeze({ name: 'あまあま' })
        ])
    }),
    Object.freeze({ name: '有-连字符', styles: Object.freeze([Object.freeze({ name: '标准' })]) })
]);
export const CONFIGS = Object.freeze({
    empty: Object.freeze({}),
    vitsConfigured: Object.freeze({
        ttsMode: 'vits-uma-genshin-honkai', ttsSpace: 'https://fixture.invalid/vits'
    }),
    azureConfigured: Object.freeze({
        ttsMode: 'azure', azureTTSKey: 'k-azure', azureTTSEmotion: true
    }),
    azureNoEmotion: Object.freeze({
        ttsMode: 'azure', azureTTSKey: 'k-azure', azureTTSEmotion: false
    }),
    voicevoxConfigured: Object.freeze({
        ttsMode: 'voicevox', voicevoxSpace: 'https://fixture.invalid/vv'
    }),
    blankSpaces: Object.freeze({ ttsSpace: '   ', azureTTSKey: '  ', voicevoxSpace: '　' }),
    wrongTypes: Object.freeze({ ttsSpace: 7, azureTTSKey: [], voicevoxSpace: null }),
    billingReady: Object.freeze({
        openAiBaseUrl: 'https://fixture.invalid/v1///', apiKey: 'k-b'
    }),
    billingBlankEndpoint: Object.freeze({ openAiBaseUrl: '   ', apiKey: 'k-b' })
});
export const MODES = Object.freeze(['vits-uma-genshin-honkai', 'azure', 'voicevox']);
export const VOICE_REQUESTS = Object.freeze([
    '随机', '', '   ', undefined, null, 42,
    '纳西妲', '草神', '火胡', '不存在的角色',
    '晓晓', 'Jenny', '晓辰', 'zh-CN-XiaoxiaoNeural',
    '护士机器子T', '四国めたん-あまあま', '四国めたん-不存在', '有-连字符',
    '  晓晓  ', 'ロ'.repeat(600)
]);
// `access_until` stays a seven-digit epoch: the fixture-safety gate rejects any 8-to-12 digit run
// as a possible QQ identifier, and the query only cares that the value parses into a valid date.
export const BILLING_RESPONSES = Object.freeze({
    healthy: {
        subscription: { ok: true, body: { hard_limit_usd: 120, access_until: 9_999_999 } },
        usage: { ok: true, body: { total_usage: 4_250 } }
    },
    subscriptionRejected: {
        subscription: { ok: false, body: {} },
        usage: { ok: true, body: { total_usage: 1 } }
    },
    usageRejected: {
        subscription: { ok: true, body: { hard_limit_usd: 1, access_until: 9_999_999 } },
        usage: { ok: false, body: {} }
    },
    missingLimit: {
        subscription: { ok: true, body: { access_until: 9_999_999 } },
        usage: { ok: true, body: { total_usage: 1 } }
    },
    missingUsage: {
        subscription: { ok: true, body: { hard_limit_usd: 1, access_until: 9_999_999 } },
        usage: { ok: true, body: {} }
    },
    invalidAccessUntil: {
        subscription: { ok: true, body: { hard_limit_usd: 1, access_until: 'soon' } },
        usage: { ok: true, body: { total_usage: 1 } }
    },
    nonObjectBodies: {
        subscription: { ok: true, body: 'nope' },
        usage: { ok: true, body: 'nope' }
    }
});
// Dates that cross a month and a year boundary once the query adds a day and subtracts 100.
export const NOW_VALUES = Object.freeze([
    '2026-10-29T12:00:00.000Z', '2026-01-31T23:30:00.000Z', '2026-03-01T00:00:00.000Z'
]);
export function recordingFetch(responseName, log) {
    const plan = BILLING_RESPONSES[responseName];
    return async (url, init) => {
        log({ host: 'fetch', url, method: init.method, headers: Object.keys(init.headers) });
        const stage = url.includes('/usage') ? 'usage' : 'subscription';
        const response = plan[stage];
        return { ok: response.ok, json: async () => response.body };
    };
}
export function convertSpeaker(voice) {
    return VITS_ALIASES[voice] ?? voice;
}
export async function runCase(api, config, fn, args) {
    let result;
    try {
        if (fn === 'getMode')
            result = api.ttsAdministration.getMode();
        else if (fn === 'isConfigured')
            result = api.ttsAdministration.isConfigured(args[0]);
        else if (fn === 'missingConfigurationMessage') {
            result = api.ttsAdministration.missingConfigurationMessage(args[0], args[1]);
        }
        else if (fn === 'selectVoice') {
            result = api.ttsAdministration.selectVoice(args[0], args[1]);
        }
        else if (fn === 'setMode') {
            api.ttsAdministration.setMode(args[0]);
            result = Object.freeze({
                storedTtsMode: config.ttsMode, getMode: api.ttsAdministration.getMode()
            });
        }
        else if (fn === 'queryLastHundredDays') {
            result = await api.billing.queryLastHundredDays(new Date(String(args[0])));
        }
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
async function row(create, fn, scenario, args) {
    const calls = [];
    const log = entry => { calls.push(encodeValue(entry)); };
    const config = { ...CONFIGS[scenario.config] };
    const api = create(config, scenario, log);
    const { result, frozen } = await runCase(api, config, fn, args);
    return Object.freeze({
        fn,
        config: scenario.config,
        response: fn === 'queryLastHundredDays' ? scenario.response : null,
        args: Object.freeze(args.map(encodeValue)),
        result: encodeValue(result),
        calls: Object.freeze(calls),
        frozen
    });
}
const TTS_CONFIGS = Object.freeze([
    'empty', 'vitsConfigured', 'azureConfigured', 'azureNoEmotion', 'voicevoxConfigured',
    'blankSpaces', 'wrongTypes'
]);
export const FIXTURE_TIMEZONE = 'UTC';
export async function buildRowsWith(create) {
    // The usage window is built from local-calendar arithmetic (`getDate()` plus one, minus a hundred),
    // so the recorded start and end dates depend on the process timezone. That dependency is real
    // legacy behaviour and is preserved; the capture and the replay both pin UTC so the committed
    // fixture means the same thing on every machine.
    const previousTimezone = process.env.TZ;
    process.env.TZ = FIXTURE_TIMEZONE;
    try {
        return await buildTtsBillingRows(create);
    }
    finally {
        if (previousTimezone === undefined)
            delete process.env.TZ;
        else
            process.env.TZ = previousTimezone;
    }
}
async function buildTtsBillingRows(create) {
    const rows = [];
    const at = (config, response = 'healthy') => Object.freeze({ config, response });
    for (const config of TTS_CONFIGS) {
        rows.push(await row(create, 'getMode', at(config), []));
        for (const mode of MODES) {
            rows.push(await row(create, 'isConfigured', at(config), [mode]));
        }
    }
    for (const mode of MODES) {
        for (const operation of ['enable', 'role']) {
            rows.push(await row(create, 'missingConfigurationMessage', at('empty'), [mode, operation]));
        }
    }
    // The emotion hint is the only part of voice selection the configuration changes, so the request
    // list is crossed against the two Azure configurations and held fixed elsewhere.
    for (const mode of MODES) {
        const configs = mode === 'azure' ? ['azureConfigured', 'azureNoEmotion'] : ['empty'];
        for (const config of configs) {
            for (const requested of VOICE_REQUESTS) {
                rows.push(await row(create, 'selectVoice', at(config), [mode, requested]));
            }
        }
    }
    for (const mode of MODES) {
        rows.push(await row(create, 'setMode', at('vitsConfigured'), [mode]));
    }
    for (const response of Object.keys(BILLING_RESPONSES)) {
        rows.push(await row(create, 'queryLastHundredDays', at('billingReady', response), [NOW_VALUES[0]]));
    }
    for (const now of NOW_VALUES) {
        rows.push(await row(create, 'queryLastHundredDays', at('billingReady', 'healthy'), [now]));
        rows.push(await row(create, 'queryLastHundredDays', at('billingBlankEndpoint', 'healthy'), [now]));
    }
    return Object.freeze(rows);
}
const LEGACY_FUNCTIONS = Object.freeze(['ttsConfigured', 'missingTtsConfiguration', 'selectVoice', 'formatDateOnly']);
export function legacyTtsBilling(source, config, scenario, log) {
    const blocks = [
        ...LEGACY_FUNCTIONS.map(name => sliceBlock(source, `\nfunction ${name} (`, '\n}\n', name)),
        sliceBlock(source, '\nconst ttsAdministration = Object.freeze({', '\n})\n', 'ttsAdministration'),
        sliceBlock(source, '\nconst billing = Object.freeze({', '\n})\n', 'billing')
    ];
    const names = [
        'Config', 'normalizedText', 'ttsMode', 'convertSpeaker', 'vitsSpeakers', 'azureVoices',
        'voiceVoxVoices', 'newFetch'
    ];
    const factory = new Function(...names, `${blocks.join('\n')}\nreturn { ttsAdministration, billing }`);
    return factory(config, normalizedText, () => resolveTtsMode(config), convertSpeaker, VITS_SPEAKERS, AZURE_VOICES, VOICEVOX_VOICES, recordingFetch(scenario.response, log));
}
export async function buildRows(source) {
    return await buildRowsWith((config, scenario, log) => legacyTtsBilling(source, config, scenario, log));
}
export async function captureBaseline(source) {
    return Object.freeze({
        schemaVersion: 1,
        baselineCommit: BASELINE_COMMIT,
        baselineSha256: sourceSha256(source),
        generator: 'src/verification/host-tts-billing-baseline.ts',
        sectionName: 'scenarios',
        section: Object.freeze({
            configs: encodeValue(CONFIGS),
            modes: encodeValue(MODES),
            vitsSpeakers: encodeValue(VITS_SPEAKERS),
            vitsAliases: encodeValue(VITS_ALIASES),
            azureVoices: encodeValue(AZURE_VOICES),
            voicevoxVoices: encodeValue(VOICEVOX_VOICES),
            voiceRequests: encodeValue(VOICE_REQUESTS),
            billingResponses: encodeValue(BILLING_RESPONSES),
            nowValues: encodeValue(NOW_VALUES),
            timezone: encodeValue(FIXTURE_TIMEZONE)
        }),
        rows: await buildRows(source)
    });
}
export async function main() {
    writeFixture(FIXTURE_PATH, await captureBaseline(legacyIndexSource(BASELINE_COMMIT)));
}
