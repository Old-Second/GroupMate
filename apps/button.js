import plugin from '../../../lib/plugins/plugin.js'
import { getProductionYunzaiAgent } from '../dist/runtime/production-yunzai-agent.js'
import {
  buildChatButtonContent,
  buildConfirmButtonContent,
  buildEndButtonContent,
  buildEntertainmentButtonContent,
  buildModeButtonContent
} from '../dist/runtime/yunzai-button-content.js'
import { buildChatSuggestionButtonRequest } from '../dist/runtime/presentation/reply-content.js'
import { pluginId } from '../dist/runtime/plugin-context.js'

const PLUGIN_CHAT = 'ChatGpt 对话'
const PLUGIN_MANAGEMENT = 'ChatGPT-Plugin 管理'
const PLUGIN_ENTERTAINMENT = 'ChatGPT-Plugin 娱乐小功能'

const FUNCTION_CHAT = 'chatgpt'
const FUNCTION_CHAT1 = 'chatgpt1'
const FUNCTION_END = 'destroyConversations'
const FUNCTION_END_ALL = 'endAllConversations'
const FUNCTION_PIC = 'switch2Picture'
const FUNCTION_TEXT = 'switch2Text'
const FUNCTION_AUDIO = 'switch2Audio'
const FUNCTION_CONFIRM_ON = 'turnOnConfirm'
const FUNCTION_CONFIRM_OFF = 'turnOffConfirm'
const FUNCTION_VERSION = 'versionChatGPTPlugin'
const FUNCTION_SHUTUP = 'shutUp'
const FUNCTION_OPEN_MOUTH = 'openMouth'
const FUNCTION_QUERY_CONFIG = 'queryConfig'
const FUNCTION_ENABLE_CONTEXT = 'enableGroupContext'
const FUNCTION_MODELS = 'viewAPIModel'
const FUNCTION_WORDCLOUD = 'wordcloud'
const FUNCTION_WORDCLOUD_LATEST = 'wordcloud_latest'
const FUNCTION_WORDCLOUD_NEW = 'wordcloud_new'
const FUNCTION_TRANSLATE = 'translate'
const FUNCTION_TRANSLATE_OCR = 'ocr'
const FUNCTION_TRANSLATE_SCREENSHOT = 'screenshotUrl'

const MAXIMUM_LEGACY_SUGGESTION_INPUT = 4_096
const MAXIMUM_SUGGESTION_COUNT = 6

function ownData (value, key) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
      ? descriptor.value
      : undefined
  } catch {
    return undefined
  }
}

function exactDataRecord (value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const actualKeys = Reflect.ownKeys(value)
  if (actualKeys.length !== keys.length ||
    actualKeys.some(key => typeof key !== 'string' || !keys.includes(key))) {
    return false
  }
  return keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && Object.hasOwn(descriptor, 'value')
  })
}

function safeStringArray (value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return undefined
  const length = ownData(value, 'length')
  if (!Number.isSafeInteger(length) || length < 0 || length > MAXIMUM_SUGGESTION_COUNT) {
    return undefined
  }
  const expectedKeys = Array.from({ length }, (_, index) => String(index)).concat('length')
  const actualKeys = Reflect.ownKeys(value)
  if (actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])) {
    return undefined
  }
  const result = []
  for (let index = 0; index < length; index += 1) {
    const suggestion = ownData(value, String(index))
    if (typeof suggestion !== 'string') return undefined
    result.push(suggestion)
  }
  return result
}

function trustedButtonRequest (value) {
  if (!exactDataRecord(value, ['schemaVersion', 'kind', 'suggestions'])) return undefined
  if (ownData(value, 'schemaVersion') !== 1 || ownData(value, 'kind') !== 'chat_suggestions') {
    return undefined
  }
  const suggestions = safeStringArray(ownData(value, 'suggestions'))
  return suggestions === undefined
    ? undefined
    : buildChatSuggestionButtonRequest(suggestions)
}

function legacyButtonRequest (value) {
  if (!exactDataRecord(value, ['suggested'])) return undefined
  const suggested = ownData(value, 'suggested')
  if (typeof suggested !== 'string') return undefined
  return buildChatSuggestionButtonRequest(
    suggested.slice(0, MAXIMUM_LEGACY_SUGGESTION_INPUT).split(/\r?\n/u)
  )
}

function buttonRequest (value) {
  try {
    return trustedButtonRequest(value) ?? legacyButtonRequest(value)
  } catch {
    return undefined
  }
}

function buttonPolicy () {
  return getProductionYunzaiAgent().buttonPolicy.snapshot()
}

export class ChatGPTButtonHandler extends plugin {
  constructor () {
    super({
      name: 'chatgpt按钮处理器',
      priority: -100,
      namespace: pluginId,
      handler: [{
        key: 'chatgpt.button.post',
        fn: 'btnHandler'
      }]
    })
  }

  async btnHandler (e, options) {
    const policy = buttonPolicy()
    if (!policy.markdownEnabled) return null
    const fnc = e.logFnc
    switch (fnc) {
      case `[${PLUGIN_CHAT}][${FUNCTION_CHAT1}]`:
      case `[${PLUGIN_CHAT}][${FUNCTION_CHAT}]`:
        return this.makeButtonChat(ownData(options, 'btnData'), policy)
      case `[${PLUGIN_CHAT}][${FUNCTION_END}]`:
      case `[${PLUGIN_CHAT}][${FUNCTION_END_ALL}]`:
        return this.makeButtonEnd(policy)
      case `[${PLUGIN_CHAT}][${FUNCTION_PIC}]`:
      case `[${PLUGIN_CHAT}][${FUNCTION_AUDIO}]`:
      case `[${PLUGIN_CHAT}][${FUNCTION_TEXT}]`:
        return this.makeButtonMode(policy)
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_VERSION}]`:
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_SHUTUP}]`:
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_OPEN_MOUTH}]`:
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_MODELS}]`:
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_QUERY_CONFIG}]`:
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_ENABLE_CONTEXT}]`:
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_CONFIRM_OFF}]`:
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_CONFIRM_ON}]`:
        return this.makeButtonConfirm(policy)
      case `[${PLUGIN_ENTERTAINMENT}][${FUNCTION_WORDCLOUD}]`:
      case `[${PLUGIN_ENTERTAINMENT}][${FUNCTION_WORDCLOUD_LATEST}]`:
      case `[${PLUGIN_ENTERTAINMENT}][${FUNCTION_WORDCLOUD_NEW}]`:
      case `[${PLUGIN_ENTERTAINMENT}][${FUNCTION_TRANSLATE}]`:
      case `[${PLUGIN_ENTERTAINMENT}][${FUNCTION_TRANSLATE_OCR}]`:
      case `[${PLUGIN_ENTERTAINMENT}][${FUNCTION_TRANSLATE_SCREENSHOT}]`:
        return this.makeButtonEntertainment(policy)
      default:
        return null
    }
  }

  makeButtonChat (options, policy = buttonPolicy()) {
    if (!policy.markdownEnabled) return null
    return buildChatButtonContent(buttonRequest(options), policy)
  }

  makeButtonEnd (policy = buttonPolicy()) {
    return policy.markdownEnabled ? buildEndButtonContent() : null
  }

  makeButtonMode (policy = buttonPolicy()) {
    return policy.markdownEnabled ? buildModeButtonContent() : null
  }

  makeButtonConfirm (policy = buttonPolicy()) {
    return policy.markdownEnabled ? buildConfirmButtonContent() : null
  }

  makeButtonEntertainment (policy = buttonPolicy()) {
    return policy.markdownEnabled ? buildEntertainmentButtonContent() : null
  }
}
