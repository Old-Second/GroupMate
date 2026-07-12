import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { resolveLegacyConversationScope } from '../../model/legacy/conversation-scope.js'
import { isLegacyToolExecutable } from '../../model/legacy/tool-visibility.js'

test('legacy conversation scope keeps private, merged group, and per-user group keys', () => {
  assert.equal(resolveLegacyConversationScope({ isGroup: false, userId: '7' }), 'private:7')
  assert.equal(resolveLegacyConversationScope({ isGroup: true, groupId: '8', userId: '7', groupMerge: true }), 'group:8')
  assert.equal(resolveLegacyConversationScope({ isGroup: true, groupId: '8', userId: '7', groupMerge: false }), 'group:8:user:7')
})

for (const toolName of ['editCard', 'jinyan', 'kickOut', 'setTitle', 'handleMsg']) {
  test(`legacy management tool ${toolName} execution requires the filtered map`, () => {
    assert.equal(isLegacyToolExecutable({ toolName, executableTools: {} }), false)
    assert.equal(isLegacyToolExecutable({ toolName, executableTools: { [toolName]: async () => {} } }), true)
  })
}

test('legacy non-management tool execution is not constrained by the filtered map', () => {
  assert.equal(isLegacyToolExecutable({ toolName: 'website', executableTools: {} }), true)
})

test('model core delegates both legacy seams without duplicate implementations', async () => {
  const source = await readFile(new URL('../../model/core.js', import.meta.url), 'utf8')
  assert.match(source, /import \{ resolveLegacyConversationScope \} from '\.\/legacy\/conversation-scope\.js'/)
  assert.match(source, /import \{ isLegacyToolExecutable \} from '\.\/legacy\/tool-visibility\.js'/)
  assert.equal(source.match(/return resolveLegacyConversationScope\(\{/g)?.length, 1)
  assert.match(source, /isGroup:\s*e\.isGroup/)
  assert.match(source, /groupId:\s*e\.group_id/)
  assert.match(source, /userId,/)
  assert.doesNotMatch(source, /function isManagementToolAvailable/)
  assert.doesNotMatch(source, /MANAGEMENT_TOOL_NAMES/)
  assert.doesNotMatch(source, /return Config\.groupMerge \?/)
  assert.match(source, /groupMerge:\s*Config\.groupMerge/)
  assert.equal(
    source.match(/isLegacyToolExecutable\(\{ toolName: resolvedTool\.name, executableTools: funcMap \}\)/g)?.length,
    2
  )
})
