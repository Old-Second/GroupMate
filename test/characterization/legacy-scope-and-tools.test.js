import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  resolveConversationScope,
  serializeConversationScope
} from '../../dist/agent/session/conversation-scope.js'

test('legacy conversation scope keeps private, merged group, and per-user group keys', () => {
  const resolve = input => serializeConversationScope(resolveConversationScope(input))
  assert.equal(resolve({ isGroup: false, userId: '7' }), 'private:7')
  assert.equal(resolve({ isGroup: true, groupId: '8', userId: '7', groupMerge: true }), 'group:8')
  assert.equal(resolve({ isGroup: true, groupId: '8', userId: '7', groupMerge: false }), 'group:8:user:7')
})

test('query tool migration keeps the reachable inventory and fixed network boundaries', async () => {
  const core = await readFile('model/core.js', 'utf8')
  const factory = await readFile('src/runtime/tools/tool-runtime-factory.ts', 'utf8')
  const website = await readFile('src/tools/WebsiteTool.ts', 'utf8')
  const search = await readFile('src/tools/SearchTool.ts', 'utf8')
  const weather = await readFile('src/tools/WeatherTool.ts', 'utf8')
  const github = await readFile('src/tools/GithubTool.ts', 'utf8')

  const inventory = [
    ['search', 'TavilySearchTool', 'createSearchTool'],
    ['website', 'WebsiteTool', 'createWebsiteTool'],
    ['weather', 'WeatherTool', 'createWeatherTool'],
    ['github', 'GithubAPITool', 'createGithubTool'],
    ['queryUserinfo', 'QueryUserinfoTool', 'createQueryUserinfoTool'],
    ['queryGenshin', 'QueryGenshinTool', 'createQueryGenshinTool'],
    ['queryStarRail', 'QueryStarRailTool', 'createQueryStarRailTool'],
    ['searchImage', 'SerpImageTool', 'createSearchImageTool'],
    ['searchVideo', 'SearchVideoTool', 'createSearchVideoTool'],
    ['searchMusic', 'SearchMusicTool', 'createSearchMusicTool'],
    ['imageCaption', 'ImageCaptionTool', 'createImageCaptionTool']
  ]
  for (const [name, _legacyClass, factoryCall] of inventory) {
    assert.equal(factory.match(new RegExp(`${factoryCall}\\(`, 'g'))?.length, 1, name)
  }
  assert.match(core, /createYunzaiToolRuntimeBridge/)
  assert.doesNotMatch(core, /utils\/tools\//)
  assert.equal(factory.match(/createSearchTool\(/g)?.length, 1)
  assert.match(search, /https:\/\/api\.tavily\.com/)
  assert.match(search, /https:\/\/api\.bing\.microsoft\.com/)
  assert.match(search, /https:\/\/serp\.ikechan8370\.com/)
  assert.match(weather, /\/v3\/config\/district/)
  assert.match(github, /\['\/search', '\/repos', '\/users', '\/orgs'\]/)
  assert.doesNotMatch(website, /ChatGPTPuppeteer|puppeteer|Chromium|browser/i)
})
