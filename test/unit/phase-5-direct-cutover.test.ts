import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const root = process.cwd()

async function source (file: string): Promise<string> {
  return await readFile(path.join(root, file), 'utf8')
}

test('Phase 5 ordinary chat and BYM have no legacy model fallback', async () => {
  const [chat, bym] = await Promise.all([source('apps/chat.js'), source('apps/bym.js')])
  const combined = `${chat}\n${bym}`

  assert.match(chat, /dist\/runtime\/agent-service-bridge\.js/)
  assert.match(chat, /\.handle\(e,\s*prompt,/)
  assert.match(bym, /dist\/runtime\/agent-service-bridge\.js/)
  assert.match(bym, /\.handleEphemeral\(e,\s*e\.msg,/)
  assert.doesNotMatch(combined, /model\/core\.js|Core\.sendMessage|core\.sendMessage/)
  assert.doesNotMatch(combined, /agentRuntimeMode|legacyRuntime|newRuntime|allowlist/i)
})

test('Phase 5 production handlers delegate conversation and approval state to the bridge', async () => {
  const [chat, approval, manager] = await Promise.all([
    source('apps/chat.js'),
    source('apps/approval.js'),
    source('src/runtime/conversation-manager.ts')
  ])

  assert.doesNotMatch(chat, /legacy-session-bridge\.js|loadOrCreate\(|sessionBridge\.save/)
  assert.match(chat, /agentServiceBridge\.conversations/)
  assert.match(approval, /routeYunzaiApprovalReply/)
  assert.doesNotMatch(manager, /LegacySessionBridge|legacy-session-bridge/)
})

test('Phase 5 visible-only and BYM empty responses are no-reply contracts', async () => {
  const [chat, bym] = await Promise.all([source('apps/chat.js'), source('apps/bym.js')])

  assert.match(chat, /visibleOutput/)
  assert.doesNotMatch(chat, /reply\(['"]没有任何回复['"]/)
  assert.match(bym, /<EMPTY>/)
})

test('Phase 5 host identity metadata is not interpolated into system instructions', async () => {
  const [chat, bym] = await Promise.all([source('apps/chat.js'), source('apps/bym.js')])

  assert.doesNotMatch(chat, /The current member is|You are participating in QQ group/)
  assert.doesNotMatch(bym, /群号是\$\{group\}|群名片是\$\{card\}|qq号是\$\{sender\}/i)
})
