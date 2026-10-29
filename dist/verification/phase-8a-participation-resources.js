import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { hostParticipationEvent } from '../agent/participation/ParticipationContract.js';
import { legacyParticipationAllowed } from '../agent/participation/ParticipationPolicy.js';
import { ParticipationShadow } from '../runtime/participation/ParticipationShadow.js';
const scenarios = ['idle', 'burst', 'scope_pressure', 'expiry'];
const percentile = (values, p) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
};
const ref = (n) => n.toString(16).padStart(64, '0');
function sample(scenario, sampleId) {
    let now = 1_000;
    const events = Array.from({ length: 256 }, (_, n) => hostParticipationEvent({ schemaVersion: 1,
        scopeRef: ref(scenario === 'scope_pressure' ? n : n % 4), actorRef: ref(n % 8), messageRef: ref(n + 1),
        origin: 'current', at: now, addressed: false, acknowledgement: false, eligible: true }));
    let maxRSS = process.memoryUsage().rss;
    // Use the same runner for both modes, including clocks, temporary events and timing storage.
    // Separate loops otherwise charge V8's benchmark/JIT allocations to shadow (even for idle).
    const run = (shadow) => {
        const times = [];
        for (let n = 0; n < 5_000; n++) {
            if (scenario === 'expiry' && n % 128 === 0)
                now += 15_000;
            const event = scenario === 'expiry' ? hostParticipationEvent({ ...events[n % 256], at: now }) : events[n % 256];
            const start = performance.now();
            const allowed = legacyParticipationAllowed({ explicitlyAddressed: false, sample: 0.01, ratePercent: 5 });
            if (scenario !== 'idle')
                shadow?.compare(event, allowed);
            times.push(performance.now() - start);
            if (n % 128 === 0)
                maxRSS = Math.max(maxRSS, process.memoryUsage().rss);
        }
        return times;
    };
    const coldRSS = process.memoryUsage().rss;
    const warmup = new ParticipationShadow(() => now, () => { });
    run(null);
    now = 1_000;
    run(warmup);
    warmup.close();
    now = 1_000;
    global.gc?.();
    const baselineTimes = run(null);
    global.gc?.();
    const baseline = process.memoryUsage();
    now = 1_000;
    maxRSS = baseline.rss;
    const candidate = new ParticipationShadow(() => now, () => { });
    const decisionTimes = run(candidate);
    maxRSS = Math.max(maxRSS, process.memoryUsage().rss);
    global.gc?.();
    const retained = process.memoryUsage();
    // libuv normalizes `ru_maxrss` to KiB on every supported platform, darwin included.
    // Measured here on darwin arm64 (libuv 1.51.0, Node 22.23.1): after allocating
    // 320 MiB, `maxRSS * 1024` reads 360.64 MiB against `memoryUsage().rss` 360.63 MiB
    // and `ps -o rss` 360.91 MiB, while reading it as bytes gives 0.35 MiB. Treating it
    // as bytes on darwin made this term 1024x too small, so it never won the maximum and
    // `peakDelta` silently degraded to the largest sampled RSS.
    const processPeak = process.resourceUsage().maxRSS * 1_024;
    maxRSS = Math.max(maxRSS, retained.rss, processPeak);
    const stats = candidate.state.stats();
    candidate.close();
    return { sampleId, scenario, node: process.version, platform: process.platform, architecture: process.arch,
        gcAvailable: typeof global.gc === 'function', warmupIterations: 5_000, warmupRSSGrowth: baseline.rss - coldRSS, baselineRSS: baseline.rss, candidateRSS: retained.rss,
        baselineHeap: baseline.heapUsed, candidateHeap: retained.heapUsed,
        retainedDelta: retained.rss - baseline.rss, peakDelta: Math.max(0, maxRSS - baseline.rss),
        baselineP50Ms: percentile(baselineTimes, 0.5), baselineP95Ms: percentile(baselineTimes, 0.95),
        decisionP50Ms: percentile(decisionTimes, 0.5), decisionP95Ms: percentile(decisionTimes, 0.95), ...stats };
}
if (process.argv[2] === '--sample') {
    const scenario = process.argv[3];
    if (!scenarios.includes(scenario))
        throw new TypeError('resource scenario invalid');
    process.stdout.write(JSON.stringify(sample(scenario, process.argv[4])) + '\n');
}
else if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const samples = [];
    for (const scenario of scenarios) {
        for (let repeat = 1; repeat <= 5; repeat++) {
            samples.push(JSON.parse(execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--sample', scenario, `${scenario}-${repeat}`], {
                encoding: 'utf8', timeout: 20_000, maxBuffer: 16_384
            })));
        }
    }
    const passed = samples.length === 20 && new Set(samples.map(s => s.sampleId)).size === 20 && samples.every(s => s.gcAvailable && s.scopes <= 64 && s.candidates <= 32 && s.bytes <= 512 * 1_024 &&
        s.retainedDelta <= 4 * 1_024 * 1_024 && s.peakDelta <= 8 * 1_024 * 1_024 && s.decisionP95Ms <= 5);
    const range = (key) => ({ min: Math.min(...samples.map(s => s[key])), max: Math.max(...samples.map(s => s[key])),
        p50: percentile(samples.map(s => s[key]), 0.5), p95: percentile(samples.map(s => s[key]), 0.95) });
    process.stdout.write(JSON.stringify({ passed, count: samples.length, retainedDelta: range('retainedDelta'), peakDelta: range('peakDelta'),
        decisionP95Ms: range('decisionP95Ms'), stateBytes: range('bytes'), samples }, null, 2) + '\n');
    if (!passed)
        process.exitCode = 1;
}
