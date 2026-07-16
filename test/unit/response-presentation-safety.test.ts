import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildChatSuggestionButtonRequest,
  normalizeCitationForwards,
  normalizeSuggestions
} from '../../src/runtime/presentation/reply-content.js'
import {
  promptIsBlocked,
  responseIsBlocked
} from '../../src/runtime/presentation/response-presentation-safety.js'

test('prompt and response block words are case-insensitive after NFC', () => {
  assert.equal(promptIsBlocked('prefix A\u030A suffix', [' å ']), true)
  assert.equal(responseIsBlocked('PRIVATE Fixture', ['private']), true)
  assert.equal(responseIsBlocked('safe response', ['', ' PRIVATE ']), false)
  assert.equal(promptIsBlocked('literal a.b', ['a.b']), true)
  assert.equal(promptIsBlocked('literal axb', ['a.b']), false)
})

test('trusted suggestions reject GroupMate control-command text', () => {
  const suggestions = normalizeSuggestions([
    ' 普通回复 ',
    '#chat1',
    '确认',
    '拒绝',
    '结束对话',
    'api结束对话 @群友',
    '开启确认',
    '今日词云',
    '群友在聊什么',
    '最新词云',
    'groupmate更新',
    'GroupMate强制更新',
    'GROUPMATE插件更新',
    'chatgpt更新',
    '柴特寄批踢插件强制更新',
    'GPT更新',
    'ChatGPT更新',
    '柴特鸡批踢更新',
    'Chat更新',
    'CHAT更新',
    '柴特更新',
    'ChatGPT-Plugin更新',
    'chatgpt-plugin强制更新',
    'chatgpt指令表',
    'chatgpt管理指令表帮助',
    'chatgpt娱乐指令表搜索词云',
    'gemini结束对话',
    '派蒙完结全部对话 @群友',
    '😀😀',
    '🇨🇳🇯🇵',
    '1️⃣2️⃣',
    '普通\n换行',
    '普通回复',
    '另一个建议',
    '今天一起散步吧',
    '我想聊聊群友在聊什么这个话题',
    '更新之后体验不错',
    '两个表情很可爱😀😀'
  ])
  assert.deepEqual(suggestions, [
    '普通回复',
    '另一个建议',
    '今天一起散步吧',
    '我想聊聊群友在聊什么这个话题',
    '更新之后体验不错',
    '两个表情很可爱😀😀'
  ])
  assert.deepEqual(buildChatSuggestionButtonRequest(suggestions), {
    schemaVersion: 1,
    kind: 'chat_suggestions',
    suggestions
  })
  assert.equal(buildChatSuggestionButtonRequest(['#chat1', '确认', '结束对话']), undefined)

  const citations = normalizeCitationForwards([
    { title: ' 文档 ', text: ' 内容 ', sourceUrl: 'https://example.com/a' },
    { title: 'bad', text: 'bad', sourceUrl: 'file:///secret' },
    ...Array.from({ length: 20 }, (_, index) => ({ title: `t${index}`, text: `x${index}` }))
  ])
  assert.equal(citations.length, 16)
  assert.deepEqual(citations[0], {
    title: '文档', text: '内容', sourceUrl: 'https://example.com/a'
  })
  assert.equal(citations.some(item => item.title === 'bad'), false)
})
