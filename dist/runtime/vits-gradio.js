import { randomUUID } from 'node:crypto';
export function buildVitsGenerateRequest(data) {
    return {
        data,
        fn_index: 0,
        session_hash: randomUUID().replaceAll('-', '')
    };
}
