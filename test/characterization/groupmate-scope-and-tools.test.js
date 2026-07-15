import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  resolveConversationScope,
  serializeConversationScope
} from '../../dist/agent/session/conversation-scope.js'

test('GroupMate conversation scope keeps private, merged group, and per-user group keys', () => {
  const resolve = input => serializeConversationScope(resolveConversationScope(input))
  assert.equal(resolve({ isGroup: false, userId: '7' }), 'private:7')
  assert.equal(resolve({ isGroup: true, groupId: '8', userId: '7', groupMerge: true }), 'group:8')
  assert.equal(resolve({ isGroup: true, groupId: '8', userId: '7', groupMerge: false }), 'group:8:user:7')
})

test('GroupMate production runtime keeps the tool inventory and one OpenAI-compatible transport', async () => {
  const bridge = await readFile('src/runtime/agent-service-bridge.ts', 'utf8')
  const factory = await readFile('src/runtime/tools/tool-runtime-factory.ts', 'utf8')
  const adapter = await readFile('src/agent/model/openai-compatible-adapter.ts', 'utf8')
  const website = await readFile('src/tools/WebsiteTool.ts', 'utf8')
  const search = await readFile('src/tools/SearchTool.ts', 'utf8')
  const weather = await readFile('src/tools/WeatherTool.ts', 'utf8')
  const github = await readFile('src/tools/GithubTool.ts', 'utf8')

  for (const [name, factoryCall] of [
    ['search', 'createSearchTool'],
    ['website', 'createWebsiteTool'],
    ['weather', 'createWeatherTool'],
    ['github', 'createGithubTool'],
    ['queryUserinfo', 'createQueryUserinfoTool'],
    ['queryGenshin', 'createQueryGenshinTool'],
    ['queryStarRail', 'createQueryStarRailTool'],
    ['searchImage', 'createSearchImageTool'],
    ['searchVideo', 'createSearchVideoTool'],
    ['searchMusic', 'createSearchMusicTool'],
    ['imageCaption', 'createImageCaptionTool']
  ]) {
    assert.equal(factory.match(new RegExp(`${factoryCall}\\(`, 'g'))?.length, 1, name)
  }
  assert.match(bridge, /createYunzaiToolRuntimeBridge/)
  assert.match(bridge, /prepareAgentRun/)
  assert.match(adapter, /class OpenAICompatibleAdapter/)
  assert.equal(factory.match(/createSearchTool\(/g)?.length, 1)
  assert.match(search, /https:\/\/api\.tavily\.com/)
  assert.match(search, /https:\/\/api\.bing\.microsoft\.com/)
  assert.match(search, /https:\/\/serp\.ikechan8370\.com/)
  assert.match(weather, /\/v3\/config\/district/)
  assert.match(github, /\['\/search', '\/repos', '\/users', '\/orgs'\]/)
  assert.doesNotMatch(website, /ChatGPTPuppeteer|puppeteer|Chromium|browser/i)

  let code
  try {
    await access('model/core.js')
  } catch (error) {
    code = error.code
  }
  assert.equal(code, 'ENOENT', 'the retired model loop must be absent')
})
