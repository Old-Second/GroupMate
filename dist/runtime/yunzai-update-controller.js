import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { updateCommandMessage } from './UpdateCommandPolicy.js';
const execute = promisify(execFile);
export async function handleUpdateCommand(input) {
    if (!input.isMaster)
        return false;
    let version = '未知';
    let commit = null;
    try {
        const data = JSON.parse(await readFile(path.join(input.root, 'package.json'), 'utf8'));
        if (typeof data.version === 'string')
            version = data.version;
    }
    catch { }
    try {
        const result = await execute('git', ['-C', input.root, 'rev-parse', '--short', 'HEAD'], {
            timeout: 2_000, maxBuffer: 1_024, windowsHide: true
        });
        commit = result.stdout.trim();
    }
    catch { }
    await input.reply(updateCommandMessage({ isMaster: true, version, commit }));
    return false;
}
