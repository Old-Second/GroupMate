import { normalizedText, type HostConfigSource } from './host-config-values.js'
import { parsePreferenceRecord, projectChatPreferences } from './host-config-projection.js'
import type { ChatPreferencePort, ChatPreferences } from '../yunzai-chat-controller.js'

// The preference record lives in the same Redis key the legacy management panel writes, so a patch
// reads the stored object, assigns only the fields it accepts and writes the same object back:
// unknown keys another feature owns must survive untouched.
export interface HostPreferenceStore {
  get(key: string): Promise<unknown>
  set(key: string, value: string): Promise<unknown>
}

export interface HostChatPreferencesDependencies {
  readonly redis: HostPreferenceStore
  readonly config: HostConfigSource
}

const BOOLEAN_FIELDS: readonly ('usePicture' | 'useTTS')[] =
  Object.freeze(['usePicture', 'useTTS'])
const VOICE_FIELDS: readonly ('ttsRole' | 'ttsRoleAzure' | 'ttsRoleVoiceVox')[] =
  Object.freeze(['ttsRole', 'ttsRoleAzure', 'ttsRoleVoiceVox'])
const VOICE_CHARACTERS = 256

export function createHostChatPreferences (
  dependencies: HostChatPreferencesDependencies
): ChatPreferencePort {
  const project = (record: Readonly<Record<string, unknown>>): ChatPreferences =>
    projectChatPreferences(record, dependencies.config)
  return Object.freeze({
    async load (actorId: string): Promise<ChatPreferences> {
      return project(parsePreferenceRecord(
        await dependencies.redis.get(`CHATGPT:USER:${actorId}`)
      ))
    },
    async patch (
      actorId: string, patch: Readonly<Partial<ChatPreferences>>
    ): Promise<ChatPreferences> {
      const key = `CHATGPT:USER:${actorId}`
      const record = parsePreferenceRecord(await dependencies.redis.get(key))
      for (const field of BOOLEAN_FIELDS) {
        if (typeof patch[field] === 'boolean') record[field] = patch[field]
      }
      for (const field of VOICE_FIELDS) {
        if (typeof patch[field] !== 'string') continue
        const value = normalizedText(patch[field], VOICE_CHARACTERS)
        if (value !== '') record[field] = value
      }
      await dependencies.redis.set(key, JSON.stringify(record))
      return project(record)
    }
  })
}
