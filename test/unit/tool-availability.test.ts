import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolRuntimeFacts } from '../../src/agent/tools/tool-context.js'
import { createManagementToolDefinitions } from '../../src/runtime/tools/tool-runtime-factory.js'
import { selectedTtsConfigured, toolAvailableInScene } from '../../src/runtime/tools/tool-availability.js'

const definitions = createManagementToolDefinitions({
  muteMember: async () => {}, kickMember: async () => {}, setCard: async () => {},
  setTitle: async () => {}, recallMessage: async () => {}, setEssence: async () => {}
})
const facts: ToolRuntimeFacts = {
  botId: '10000', actor: { userId: '7', role: 'member', isBotMaster: false },
  channel: { kind: 'group', botId: '10000', groupId: '9' }, scope: { kind: 'group', groupId: '9' },
  actorGroupRole: 'member', botGroupRole: 'admin', targetRole: 'none', targetExists: false, targetIsBotMaster: false
}
const visible = (input: ToolRuntimeFacts, disabled: unknown = []): string[] => definitions
  .filter(tool => toolAvailableInScene(tool, input, disabled)).map(tool => tool.name).sort()

test('discovery hides impossible management but keeps member self-service', () => {
  assert.deepEqual(visible(facts), ['editCard', 'jinyan'])
  assert.deepEqual(visible({ ...facts, actorGroupRole: 'admin' }), ['editCard', 'handleMsg', 'jinyan'])
  assert.deepEqual(visible({ ...facts, actorGroupRole: 'owner' }), ['editCard', 'handleMsg', 'jinyan', 'kickOut'])
  assert.deepEqual(visible({ ...facts, actorGroupRole: 'owner', botGroupRole: 'owner' }), ['editCard', 'handleMsg', 'jinyan', 'kickOut', 'setTitle'])
  assert.deepEqual(visible({ ...facts, botGroupRole: 'member' }), [])
  assert.deepEqual(visible(facts, ['jinyan']), ['editCard'])
})

test('TTS discovery requires the selected backend rather than any unrelated credential', () => {
  assert.equal(selectedTtsConfigured({ ttsMode: 'azure', ttsSpace: 'configured' }), false)
  assert.equal(selectedTtsConfigured({ ttsMode: 'azure', azureTTSKey: 'configured' }), false)
  assert.equal(selectedTtsConfigured({ ttsMode: 'azure', azureTTSKey: 'configured', azureTTSRegion: 'configured' }), true)
  assert.equal(selectedTtsConfigured({ ttsMode: 'voicevox', azureTTSKey: 'configured' }), false)
  assert.equal(selectedTtsConfigured({ ttsMode: 'voicevox', voicevoxSpace: 'configured' }), true)
  assert.equal(selectedTtsConfigured({ ttsSpace: 'configured' }), true)
  assert.equal(selectedTtsConfigured({ ttsMode: 'unknown', ttsSpace: 'configured' }), false)
})
