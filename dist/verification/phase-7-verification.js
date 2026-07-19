import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { auditPhase7SecurityBoundaries } from './phase-7-security-audit.js';
export const PHASE_7_VERIFICATION_CHECKS = Object.freeze([
    'build',
    'typecheck',
    'offline',
    'unit',
    'characterization',
    'resources',
    'security',
    'dist_reproducible'
]);
const MAX_DIST_JAVASCRIPT_FILES = 1_024;
const MAX_DIST_JAVASCRIPT_FILE_BYTES = 2 * 1_024 * 1_024;
const MAX_DIST_JAVASCRIPT_TOTAL_BYTES = 64 * 1_024 * 1_024;
const DIST_HASH_DOMAIN = 'groupmate.phase7.dist-javascript.v1';
const COMMAND_TIMEOUT_MS = 10 * 60_000;
function command(name, file, arguments_) {
    return Object.freeze({
        name,
        file,
        arguments: Object.freeze([...arguments_])
    });
}
const COMMANDS = Object.freeze({
    build: command('build', 'pnpm', ['run', 'build']),
    typecheck: command('typecheck', 'pnpm', ['exec', 'tsc', '-p', 'tsconfig.test.json']),
    offline: command('offline', 'pnpm', ['test']),
    unit: command('unit', 'pnpm', ['run', 'test:unit']),
    characterization: command('characterization', 'pnpm', ['run', 'test:characterization']),
    resources: command('resources', process.execPath, ['scripts/measure-phase-7-resources.mjs'])
});
const DIST_BUILD_COMMAND = command('dist_reproducible', 'pnpm', ['run', 'build']);
function projectRoot(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError('Phase 7 verification project root is invalid');
    }
    return path.resolve(value);
}
function result(name, passed) {
    return Object.freeze({
        name,
        mandatory: true,
        status: passed ? 'passed' : 'failed',
        code: passed ? 'ok' : 'command_failed'
    });
}
function defaultRunner(root) {
    return async (input) => {
        const child = spawnSync(input.file, input.arguments, {
            cwd: root,
            encoding: 'utf8',
            timeout: COMMAND_TIMEOUT_MS,
            stdio: 'inherit'
        });
        if (child.error !== undefined || child.status === null)
            return 1;
        return child.status;
    };
}
async function collectDistJavaScript(root, relative = '') {
    const current = path.join(root, relative);
    const entries = await readdir(current, { withFileTypes: true });
    const files = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory())
            files.push(...await collectDistJavaScript(root, child));
        else if (entry.isFile() && child.endsWith('.js'))
            files.push(child);
        else if (entry.isSymbolicLink() && child.endsWith('.js')) {
            throw new TypeError('Phase 7 dist JavaScript entry is invalid');
        }
        if (files.length > MAX_DIST_JAVASCRIPT_FILES) {
            throw new RangeError('Phase 7 dist JavaScript file count exceeded');
        }
    }
    return Object.freeze(files);
}
function hashFrame(hash, value) {
    hash.update(String(value.length), 'ascii');
    hash.update(':', 'ascii');
    hash.update(value);
    hash.update('\0', 'ascii');
}
export async function phase7DistJavaScriptHash(value) {
    const root = projectRoot(value);
    const dist = path.join(root, 'dist');
    const files = [...await collectDistJavaScript(dist)].sort();
    if (files.length === 0)
        throw new TypeError('Phase 7 dist JavaScript is missing');
    const hash = createHash('sha256').update(DIST_HASH_DOMAIN, 'ascii').update('\0', 'ascii');
    let totalBytes = 0;
    for (const relativePath of files) {
        const content = await readFile(path.join(dist, relativePath));
        if (content.length > MAX_DIST_JAVASCRIPT_FILE_BYTES) {
            throw new RangeError('Phase 7 dist JavaScript file size exceeded');
        }
        totalBytes += content.length;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_DIST_JAVASCRIPT_TOTAL_BYTES) {
            throw new RangeError('Phase 7 dist JavaScript total size exceeded');
        }
        hashFrame(hash, Buffer.from(relativePath, 'utf8'));
        hashFrame(hash, content);
    }
    return hash.digest('hex');
}
export async function verifyPhase7(value, options = {}) {
    const root = projectRoot(value);
    const runCommand = options.runCommand ?? defaultRunner(root);
    const securityAudit = options.securityAudit ?? auditPhase7SecurityBoundaries;
    const distJavaScriptHash = options.distJavaScriptHash ?? phase7DistJavaScriptHash;
    const checks = [];
    for (const name of [
        'build',
        'typecheck',
        'offline',
        'unit',
        'characterization',
        'resources'
    ]) {
        let passed = false;
        try {
            passed = await runCommand(COMMANDS[name]) === 0;
        }
        catch {
            passed = false;
        }
        checks.push(result(name, passed));
    }
    let securityPassed = false;
    try {
        securityPassed = (await securityAudit(root)).passed;
    }
    catch {
        securityPassed = false;
    }
    checks.push(result('security', securityPassed));
    let distReproducible = false;
    try {
        const before = await distJavaScriptHash(root);
        let rebuilt = false;
        try {
            rebuilt = await runCommand(DIST_BUILD_COMMAND) === 0;
        }
        catch {
            rebuilt = false;
        }
        if (rebuilt) {
            const after = await distJavaScriptHash(root);
            distReproducible = before === after;
        }
    }
    catch {
        distReproducible = false;
    }
    checks.push(result('dist_reproducible', distReproducible));
    const ordered = Object.freeze(PHASE_7_VERIFICATION_CHECKS.map(name => {
        const check = checks.find(current => current.name === name);
        if (check === undefined)
            throw new Error(`Phase 7 verification check missing: ${name}`);
        return check;
    }));
    return Object.freeze({
        checks: ordered,
        passed: ordered.every(check => check.status === 'passed')
    });
}
export async function main() {
    const verification = await verifyPhase7(process.cwd());
    process.stdout.write(`${JSON.stringify(verification, null, 2)}\n`);
    if (!verification.passed)
        process.exitCode = 1;
}
