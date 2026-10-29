import { normalizedText } from './host-config-values.js';
import { parsePreferenceRecord, projectChatPreferences } from './host-config-projection.js';
const BOOLEAN_FIELDS = Object.freeze(['usePicture', 'useTTS']);
const VOICE_FIELDS = Object.freeze(['ttsRole', 'ttsRoleAzure', 'ttsRoleVoiceVox']);
const VOICE_CHARACTERS = 256;
export function createHostChatPreferences(dependencies) {
    const project = (record) => projectChatPreferences(record, dependencies.config);
    return Object.freeze({
        async load(actorId) {
            return project(parsePreferenceRecord(await dependencies.redis.get(`CHATGPT:USER:${actorId}`)));
        },
        async patch(actorId, patch) {
            const key = `CHATGPT:USER:${actorId}`;
            const record = parsePreferenceRecord(await dependencies.redis.get(key));
            for (const field of BOOLEAN_FIELDS) {
                if (typeof patch[field] === 'boolean')
                    record[field] = patch[field];
            }
            for (const field of VOICE_FIELDS) {
                if (typeof patch[field] !== 'string')
                    continue;
                const value = normalizedText(patch[field], VOICE_CHARACTERS);
                if (value !== '')
                    record[field] = value;
            }
            await dependencies.redis.set(key, JSON.stringify(record));
            return project(record);
        }
    });
}
