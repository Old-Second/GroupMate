import { buildChatButtonContent } from '../runtime/yunzai-button-content.js';
import { materializeYunzaiForwardMessage } from '../runtime/presentation/yunzai-forward-message.js';
import { materializeYunzaiMagicSegment } from '../runtime/presentation/yunzai-magic-segment.js';
import { materializeYunzaiMusicSegment } from '../runtime/presentation/yunzai-music-segment.js';
import { encodeValue, legacyIndexSource, sliceBlock, sourceSha256, writeFixture } from './host-bootstrap-fixture.js';
export const BASELINE_COMMIT = '5bf84e2c05f43c118f28ca0d21480a0474708203';
export const FIXTURE_PATH = 'test/fixtures/host-bootstrap/batch-3-outbound.json';
// Host segment factories. A Yunzai build exposes whichever of these its protocol adapter supports,
// and every missing one has to fall back to the plain OneBot v11 object.
export const SEGMENT_FACTORIES = Object.freeze(['at', 'face', 'markdown', 'image', 'record', 'video', 'music', 'dice', 'rps', 'reply']);
export const SEGMENTS = Object.freeze({
    none: Object.freeze([]),
    all: SEGMENT_FACTORIES,
    partial: Object.freeze(['at', 'image', 'reply'])
});
export function hostSegment(available, log) {
    const segment = {};
    for (const name of available) {
        segment[name] = (...args) => {
            log({ host: `segment.${name}`, args: args.map(encodeValue) });
            return { type: name, via: 'host', args: args.map(encodeValue) };
        };
    }
    return segment;
}
const BUFFER = Object.freeze({
    kind: 'buffer',
    data: Uint8Array.from([0, 1, 2, 250]),
    mimeType: 'image/png',
    byteLength: 4
});
export const RESOURCES = Object.freeze({
    buffer: BUFFER,
    remote: Object.freeze({
        kind: 'remote_url',
        url: 'https://fixture.invalid/a.png',
        mimeType: 'image/png',
        byteLength: 11
    }),
    local: Object.freeze({
        kind: 'local_path',
        path: '/fixture/local.png',
        mimeType: 'image/png',
        byteLength: 12
    })
});
export const ATOMS = Object.freeze({
    text: Object.freeze({ kind: 'text', text: '群里的一句话' }),
    emptyText: Object.freeze({ kind: 'text', text: '' }),
    atAll: Object.freeze({ kind: 'at', target: 'all' }),
    atUser: Object.freeze({ kind: 'at', target: Object.freeze({ userId: '10086' }) }),
    face: Object.freeze({ kind: 'face', faceId: 14 }),
    markdown: Object.freeze({ kind: 'markdown', markdown: '**粗体**' })
});
export const PARTS = Object.freeze({
    textSingle: Object.freeze({ media: 'text', atoms: Object.freeze([ATOMS.text]) }),
    textMultiple: Object.freeze({
        media: 'text',
        atoms: Object.freeze([ATOMS.atUser, ATOMS.text, ATOMS.face, ATOMS.markdown])
    }),
    textEmptyAtoms: Object.freeze({ media: 'text', atoms: Object.freeze([]) }),
    textWithButtons: Object.freeze({
        media: 'text',
        atoms: Object.freeze([ATOMS.text]),
        buttons: Object.freeze({
            schemaVersion: 1,
            kind: 'chat_suggestions',
            suggestions: Object.freeze(['继续', '换个话题'])
        })
    }),
    textWithUnsupportedButtons: Object.freeze({
        media: 'text',
        atoms: Object.freeze([ATOMS.text]),
        buttons: Object.freeze({
            schemaVersion: 1,
            kind: 'chat_suggestions',
            suggestions: Object.freeze([])
        })
    }),
    pictureBuffer: Object.freeze({ media: 'picture', resource: RESOURCES.buffer }),
    pictureRemote: Object.freeze({ media: 'picture', resource: RESOURCES.remote }),
    pictureLocal: Object.freeze({ media: 'picture', resource: RESOURCES.local }),
    voicePlain: Object.freeze({ media: 'voice', resource: RESOURCES.local }),
    voiceHostRecord: Object.freeze({
        media: 'voice', resource: RESOURCES.local, hostRecord: 'protobuf://QUJD'
    }),
    video: Object.freeze({ media: 'video', resource: RESOURCES.remote }),
    music: Object.freeze({ media: 'music', provider: '163', id: '1234567' }),
    musicInvalid: Object.freeze({ media: 'music', provider: '163', id: 'abc' }),
    dice: Object.freeze({ media: 'dice' }),
    rpsOne: Object.freeze({ media: 'rps', value: 1 }),
    rpsThree: Object.freeze({ media: 'rps', value: 3 }),
    forward: Object.freeze({
        media: 'forward',
        title: '转发标题',
        nodes: Object.freeze([
            Object.freeze({ kind: 'text', text: '第一条' }),
            Object.freeze({ kind: 'text', text: '第二条' })
        ])
    })
});
export const BUTTON_POLICIES = Object.freeze({
    markdownOn: Object.freeze({ markdownEnabled: true, openAiConfigured: true }),
    markdownOff: Object.freeze({ markdownEnabled: false, openAiConfigured: true })
});
export const TARGETS = Object.freeze({
    group: Object.freeze({
        botId: '10001', scope: Object.freeze({ kind: 'group', groupId: '700' })
    }),
    private: Object.freeze({
        botId: '10001', scope: Object.freeze({ kind: 'private', userId: '800' })
    }),
    groupUser: Object.freeze({
        botId: '10001',
        scope: Object.freeze({ kind: 'group_user', groupId: '700', userId: '800' })
    })
});
export const BOTS = Object.freeze([
    'missing', 'noPickers', 'primitiveReceiver', 'receiverWithoutSendMsg',
    'receiverWithRecall', 'receiverWithoutRecall', 'throwingSendMsg'
]);
export function botPickerFor(name, log) {
    const receiver = (recall) => {
        const sink = {
            sendMsg: (message) => {
                log({ host: 'sendMsg', message: encodeValue(message), self: sink.label });
                return { sent: sink.label, echo: 'message-1' };
            },
            makeForwardMsg: (nodes) => {
                log({ host: 'makeForwardMsg', nodes: encodeValue(nodes) });
                return { type: 'forward', via: 'host' };
            },
            label: 'receiver'
        };
        if (recall) {
            sink.recallMsg = (messageId) => {
                log({ host: 'recallMsg', messageId: encodeValue(messageId) });
                return true;
            };
        }
        return sink;
    };
    const pickers = (sink) => ({
        uin: '10001',
        pickGroup: (groupId) => {
            log({ host: 'pickGroup', groupId: encodeValue(groupId) });
            return sink;
        },
        pickFriend: (userId) => {
            log({ host: 'pickFriend', userId: encodeValue(userId) });
            return sink;
        }
    });
    const bots = Object.freeze({
        missing: null,
        noPickers: Object.freeze({ uin: '10001' }),
        primitiveReceiver: pickers('not-an-object'),
        receiverWithoutSendMsg: pickers(Object.freeze({ label: 'no-send' })),
        receiverWithRecall: pickers(receiver(true)),
        receiverWithoutRecall: pickers(receiver(false)),
        throwingSendMsg: pickers(Object.freeze({
            label: 'throwing',
            sendMsg: () => {
                log({ host: 'sendMsg', outcome: 'threw' });
                throw new Error('host refused the message');
            }
        }))
    });
    return Object.freeze({
        pick: async (botId) => {
            log({ host: 'pick', botId });
            return bots[name];
        }
    });
}
// Flows exist because `forTarget` hands back a port whose dispatch and recall share one receiver;
// only a sequence can record that the port keeps talking to the same host object.
export const FLOWS = Object.freeze({
    dispatchPlain: Object.freeze(['dispatch:textSingle']),
    dispatchQuoted: Object.freeze(['dispatch:textSingle:message-0']),
    dispatchQuotedMultiple: Object.freeze(['dispatch:textMultiple:message-0']),
    dispatchForward: Object.freeze(['dispatch:forward']),
    dispatchThenRecall: Object.freeze(['dispatch:textSingle', 'recall:message-1']),
    dispatchAborted: Object.freeze(['dispatchAborted:textSingle']),
    recallAborted: Object.freeze(['recallAborted:message-1']),
    recallOnly: Object.freeze(['recall:7'])
});
export function buttonPolicyPort(name) {
    return Object.freeze({ snapshot: () => BUTTON_POLICIES[name] });
}
async function runFlow(api, target, steps, log) {
    const port = await api.outboundHost.forTarget(target);
    if (port === null)
        return Object.freeze({ port: null });
    const outcomes = [];
    for (const step of steps) {
        const [action, first, second] = step.split(':');
        const aborted = new AbortController();
        aborted.abort(new Error('flow aborted before dispatch'));
        try {
            if (action === 'dispatch') {
                outcomes.push({
                    step, value: encodeValue(await port.dispatch(PARTS[first], second, undefined))
                });
            }
            else if (action === 'dispatchAborted') {
                outcomes.push({
                    step,
                    value: encodeValue(await port.dispatch(PARTS[first], undefined, aborted.signal))
                });
            }
            else if (action === 'recall') {
                outcomes.push({ step, value: encodeValue(await port.recall(first)) });
            }
            else if (action === 'recallAborted') {
                outcomes.push({
                    step, value: encodeValue(await port.recall(first, aborted.signal))
                });
            }
            else
                throw new Error(`unknown flow action: ${action}`);
        }
        catch (error) {
            outcomes.push({ step, thrown: encodeValue(error) });
        }
    }
    log({ flow: 'completed' });
    return Object.freeze({ port: 'acquired', outcomes });
}
export async function runCase(api, fn, args, log) {
    let result;
    try {
        if (fn === 'resourceValue')
            result = api.resourceValue(RESOURCES[String(args[0])]);
        else if (fn === 'textAtomValue')
            result = api.textAtomValue(ATOMS[String(args[0])]);
        else if (fn === 'outboundMessage') {
            const receiver = {
                makeForwardMsg: (nodes) => {
                    log({ host: 'makeForwardMsg', nodes: encodeValue(nodes) });
                    return { type: 'forward', via: 'host' };
                }
            };
            result = await api.outboundMessage(receiver, PARTS[String(args[0])]);
        }
        else if (fn === 'outboundMessageWithoutForwardSupport') {
            result = await api.outboundMessage(Object.freeze({}), PARTS[String(args[0])]);
        }
        else if (fn === 'flow') {
            result = await runFlow(api, TARGETS[String(args[1])], FLOWS[String(args[0])], log);
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
async function row(create, fn, scenario, labels, args) {
    const calls = [];
    const log = entry => { calls.push(encodeValue(entry)); };
    const api = await create(scenario, log);
    const { result, frozen } = await runCase(api, fn, args, log);
    return Object.freeze({
        fn,
        segment: labels.segment === true ? scenario.segment : null,
        buttonPolicy: labels.buttonPolicy === true ? scenario.buttonPolicy : null,
        bot: labels.bot === true ? scenario.bot : null,
        target: labels.target ?? null,
        args: Object.freeze(args.map(encodeValue)),
        result: encodeValue(result),
        calls: Object.freeze(calls),
        frozen
    });
}
const BUTTONED_PARTS = Object.freeze(Object.keys(PARTS)
    .filter(name => Object.hasOwn(PARTS[name], 'buttons')));
// Bots whose receiver actually accepts a message: only those can run the full flow list.
const DISPATCHING_BOTS = Object.freeze(['receiverWithRecall', 'receiverWithoutRecall', 'throwingSendMsg']);
export async function buildRowsWith(create) {
    const rows = [];
    const base = { segment: 'all', buttonPolicy: 'markdownOn', bot: 'missing' };
    for (const name of Object.keys(RESOURCES)) {
        rows.push(await row(create, 'resourceValue', base, {}, [name]));
    }
    for (const segment of Object.keys(SEGMENTS)) {
        for (const name of Object.keys(ATOMS)) {
            rows.push(await row(create, 'textAtomValue', { ...base, segment }, { segment: true }, [name]));
        }
    }
    // The button policy only changes the answer for a part that carries a button request: without
    // one the builder returns null under either policy, so those parts stay on a single policy.
    for (const segment of Object.keys(SEGMENTS)) {
        for (const name of Object.keys(PARTS)) {
            const policies = BUTTONED_PARTS.includes(name)
                ? Object.keys(BUTTON_POLICIES)
                : ['markdownOn'];
            for (const buttonPolicy of policies) {
                rows.push(await row(create, 'outboundMessage', { ...base, segment, buttonPolicy }, { segment: true, buttonPolicy: true }, [name]));
            }
        }
    }
    // A receiver with no `makeForwardMsg` is the fallback path the forward materializer owns.
    rows.push(await row(create, 'outboundMessageWithoutForwardSupport', base, { segment: true }, ['forward']));
    for (const bot of BOTS) {
        rows.push(await row(create, 'flow', { ...base, bot }, { bot: true, segment: true, target: 'group' }, ['dispatchPlain', 'group']));
    }
    // Group, private and group_user pick different host channels; one working receiver shows all.
    for (const target of ['private', 'groupUser']) {
        rows.push(await row(create, 'flow', { ...base, bot: 'receiverWithRecall' }, { bot: true, segment: true, target }, ['dispatchPlain', target]));
    }
    for (const bot of DISPATCHING_BOTS) {
        for (const flow of Object.keys(FLOWS)) {
            if (flow === 'dispatchPlain')
                continue;
            rows.push(await row(create, 'flow', { ...base, bot }, { bot: true, segment: true, target: 'group' }, [flow, 'group']));
        }
    }
    return Object.freeze(rows);
}
// The legacy helpers read `globalThis.segment` at several points, including after an `await`, so the
// host factory is installed for the whole asynchronous call and restored when it settles. Rows run
// one at a time, which keeps the window exact and leaves no global behind.
async function withSegment(segment, call) {
    const host = globalThis;
    const had = Object.hasOwn(host, 'segment');
    const previous = host.segment;
    host.segment = segment;
    try {
        return await call();
    }
    finally {
        if (had)
            host.segment = previous;
        else
            delete host.segment;
    }
}
function withSegmentSync(segment, call) {
    const host = globalThis;
    const had = Object.hasOwn(host, 'segment');
    const previous = host.segment;
    host.segment = segment;
    try {
        return call();
    }
    finally {
        if (had)
            host.segment = previous;
        else
            delete host.segment;
    }
}
export function legacyOutbound(source, scenario, log) {
    const blocks = [
        sliceBlock(source, '\nfunction resourceValue (', '\n}\n', 'resourceValue'),
        sliceBlock(source, '\nfunction textAtomValue (', '\n}\n', 'textAtomValue'),
        sliceBlock(source, '\nasync function outboundMessage (', '\n}\n', 'outboundMessage'),
        sliceBlock(source, '\nconst outboundHost = Object.freeze({', '\n})\n', 'outboundHost')
    ];
    const names = [
        'buttonPolicy', 'buildChatButtonContent', 'materializeYunzaiMusicSegment',
        'materializeYunzaiMagicSegment', 'materializeYunzaiForwardMessage', 'botPicker'
    ];
    const factory = new Function(...names, `${blocks.join('\n')}\nreturn { resourceValue, textAtomValue, outboundMessage, outboundHost }`);
    // The legacy helpers took these as module imports; the migrated module imports them itself, so
    // both sides reach the project's real implementations and only the delivery route differs.
    const api = factory(buttonPolicyPort(scenario.buttonPolicy), buildChatButtonContent, materializeYunzaiMusicSegment, materializeYunzaiMagicSegment, materializeYunzaiForwardMessage, botPickerFor(scenario.bot, log));
    const segment = hostSegment(SEGMENTS[scenario.segment], log);
    return Object.freeze({
        resourceValue: (resource) => api.resourceValue(resource),
        textAtomValue: (atom) => withSegmentSync(segment, () => api.textAtomValue(atom)),
        outboundMessage: async (receiver, part) => await withSegment(segment, async () => await api.outboundMessage(receiver, part)),
        outboundHost: Object.freeze({
            forTarget: async (target) => {
                const port = await withSegment(segment, async () => await api.outboundHost.forTarget(target));
                if (port === null)
                    return null;
                return Object.freeze({
                    dispatch: async (part, quoteMessageId, signal) => await withSegment(segment, async () => await port.dispatch(part, quoteMessageId, signal)),
                    recall: async (messageId, signal) => await withSegment(segment, async () => await port.recall(messageId, signal))
                });
            }
        })
    });
}
export async function buildRows(source) {
    return await buildRowsWith((scenario, log) => legacyOutbound(source, scenario, log));
}
export async function captureBaseline(source) {
    return Object.freeze({
        schemaVersion: 1,
        baselineCommit: BASELINE_COMMIT,
        baselineSha256: sourceSha256(source),
        generator: 'src/verification/host-outbound-baseline.ts',
        sectionName: 'scenarios',
        section: Object.freeze({
            segments: encodeValue(SEGMENTS),
            resources: encodeValue(RESOURCES),
            atoms: encodeValue(ATOMS),
            parts: encodeValue(PARTS),
            buttonPolicies: encodeValue(BUTTON_POLICIES),
            targets: encodeValue(TARGETS),
            bots: encodeValue(BOTS),
            flows: encodeValue(FLOWS)
        }),
        rows: await buildRows(source)
    });
}
export async function main() {
    writeFixture(FIXTURE_PATH, await captureBaseline(legacyIndexSource(BASELINE_COMMIT)));
}
