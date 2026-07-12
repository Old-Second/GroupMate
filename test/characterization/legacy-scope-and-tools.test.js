import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  resolveConversationScope,
  serializeConversationScope
} from '../../dist/agent/session/conversation-scope.js'
import { isLegacyToolExecutable } from '../../model/legacy/tool-visibility.js'

test('legacy conversation scope keeps private, merged group, and per-user group keys', () => {
  const resolve = input => serializeConversationScope(resolveConversationScope(input))
  assert.equal(resolve({ isGroup: false, userId: '7' }), 'private:7')
  assert.equal(resolve({ isGroup: true, groupId: '8', userId: '7', groupMerge: true }), 'group:8')
  assert.equal(resolve({ isGroup: true, groupId: '8', userId: '7', groupMerge: false }), 'group:8:user:7')
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
