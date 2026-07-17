import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const root = process.cwd()

async function source (file: string): Promise<string> {
  return await readFile(path.join(root, file), 'utf8')
}

test('Phase 5 ordinary chat and BYM enter only through the production graph', async () => {
  const [chat, bym] = await Promise.all([
    source('apps/chat.js'),
    source('apps/bym.js')
  ])
  const combined = `${chat}\n${bym}`

  assert.match(chat, /dist\/runtime\/production-yunzai-agent\.js/)
  assert.match(chat, /getProductionYunzaiAgent\(\)\.chatController\.chatgpt\(event\)/)
  assert.match(bym, /dist\/runtime\/production-yunzai-agent\.js/)
  assert.match(bym, /getProductionYunzaiAgent\(\)\.bymController\.bym\(event\)/)
  assert.doesNotMatch(combined, /agent-service-bridge|bym-trigger|handleEphemeral|\.handle\(/)
  assert.doesNotMatch(combined, /model\/core\.js|Core\.sendMessage|core\.sendMessage/)
  assert.doesNotMatch(combined, /agentRuntimeMode|legacyRuntime|newRuntime|allowlist/i)
})

test('Phase 5 production handlers delegate conversation and approval state to typed controllers', async () => {
  const [chat, approval, chatController, approvalController, manager] = await Promise.all([
    source('apps/chat.js'),
    source('apps/approval.js'),
    source('src/runtime/yunzai-chat-controller.ts'),
    source('src/runtime/yunzai-approval-controller.ts'),
    source('src/runtime/conversation-manager.ts')
  ])

  assert.doesNotMatch(chat, /legacy-session-bridge\.js|loadOrCreate\(|sessionBridge\.save/)
  assert.match(chat, /getProductionYunzaiAgent\(\)\.chatController\.getAllConversations\(event\)/)
  assert.match(chatController, /listConversations\(/)
  assert.match(chatController, /options\.agent\.conversations/)
  assert.match(approval, /getProductionYunzaiAgent\(\)\.approvalController\.confirmToolOperation\(event\)/)
  assert.match(approvalController, /options\.router\.route\(/)
  assert.doesNotMatch(manager, /LegacySessionBridge|legacy-session-bridge/)
})

test('Phase 5 entry shells contain no terminal response implementation', async () => {
  const [chat, bym, approval] = await Promise.all([
    source('apps/chat.js'),
    source('apps/bym.js'),
    source('apps/approval.js')
  ])
  const combined = `${chat}\n${bym}\n${approval}`

  assert.doesNotMatch(combined, /visibleOutput|<EMPTY>|没有任何回复/)
  assert.doesNotMatch(combined, /\.reply\(|present|recall|generateAudio|render/i)
})

test('Phase 5 host identity metadata is not interpolated into system instructions', async () => {
  const [chat, bym, bymController] = await Promise.all([
    source('apps/chat.js'),
    source('apps/bym.js'),
    source('src/runtime/yunzai-bym-controller.ts')
  ])

  assert.doesNotMatch(chat, /The current member is|You are participating in QQ group/)
  assert.doesNotMatch(bym, /群号是\$\{group\}|群名片是\$\{card\}|qq号是\$\{sender\}/i)
  assert.doesNotMatch(bymController, /群号是\$\{group\}|群名片是\$\{card\}|qq号是\$\{sender\}/i)
})
