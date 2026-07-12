import plugin from '../../../lib/plugins/plugin.js'
import { Config } from '../utils/config.js'
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
    if (!Config.enableMd) {
      return null
    }
    const fnc = e.logFnc
    switch (fnc) {
      case `[${PLUGIN_CHAT}][${FUNCTION_CHAT1}]`:
      case `[${PLUGIN_CHAT}][${FUNCTION_CHAT}]`:
        return this.makeButtonChat(options?.btnData)
      case `[${PLUGIN_CHAT}][${FUNCTION_END}]`:
      case `[${PLUGIN_CHAT}][${FUNCTION_END_ALL}]`:
        return this.makeButtonEnd()
      case `[${PLUGIN_CHAT}][${FUNCTION_PIC}]`:
      case `[${PLUGIN_CHAT}][${FUNCTION_AUDIO}]`:
      case `[${PLUGIN_CHAT}][${FUNCTION_TEXT}]`:
        return this.makeButtonMode()
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_VERSION}]`:
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_SHUTUP}]`:
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_OPEN_MOUTH}]`:
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_MODELS}]`:
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_QUERY_CONFIG}]`:
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_ENABLE_CONTEXT}]`:
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_CONFIRM_OFF}]`:
      case `[${PLUGIN_MANAGEMENT}][${FUNCTION_CONFIRM_ON}]`:
        return this.makeButtonConfirm()
      case `[${PLUGIN_ENTERTAINMENT}][${FUNCTION_WORDCLOUD}]`:
      case `[${PLUGIN_ENTERTAINMENT}][${FUNCTION_WORDCLOUD_LATEST}]`:
      case `[${PLUGIN_ENTERTAINMENT}][${FUNCTION_WORDCLOUD_NEW}]`:
      case `[${PLUGIN_ENTERTAINMENT}][${FUNCTION_TRANSLATE}]`:
      case `[${PLUGIN_ENTERTAINMENT}][${FUNCTION_TRANSLATE_OCR}]`:
      case `[${PLUGIN_ENTERTAINMENT}][${FUNCTION_TRANSLATE_SCREENSHOT}]`:
        return this.makeButtonEntertainment()
      default:
        return null
    }
  }

  makeButtonChat (options) {
    const rows = [{
      buttons: [
        createButtonBase('结束对话', '#毁灭对话'),
        createButtonBase('结束当前对话', '#api结束对话'),
        createButtonBase('at我对话', '', false)
      ]
    }]

    if (Config.apiKey) {
      rows.push({
        buttons: [createButtonBase('OpenAI-compatible', '#chat1', false)]
      })
    }
    if (options?.suggested) {
      rows.unshift({
        buttons: options.suggested.split('\n').map(text => createButtonBase(text, text))
      })
    }
    return {
      appid: 1,
      rows
    }
  }

  makeButtonEnd () {
    return {
      appid: 1,
      rows: [{
        buttons: [
          createButtonBase('重新开始', '#摧毁对话'),
          createButtonBase('全部结束', '#摧毁全部对话'),
          createButtonBase('开始对话', '#chat1', false)
        ]
      }]
    }
  }

  makeButtonMode () {
    return {
      appid: 1,
      rows: [{
        buttons: [
          createButtonBase('以文字回复', '#chatgpt文本模式'),
          createButtonBase('以图片回复', '#chatgpt图片模式'),
          createButtonBase('以语音回复', '#chatgpt语音模式')
        ]
      }]
    }
  }

  makeButtonConfirm () {
    return {
      appid: 1,
      rows: [
        {
          buttons: [
            createButtonBase('开启确认', '#chatgpt开启确认'),
            createButtonBase('关闭确认', '#chatgpt关闭确认'),
            createButtonBase('暂停本群回复', '#chatgpt本群闭嘴', false)
          ]
        },
        {
          buttons: [
            createButtonBase('恢复本群回复', '#chatgpt本群张嘴', false),
            createButtonBase('开启上下文', '#打开群聊上下文'),
            createButtonBase('关闭上下文 ', '#关闭群聊上下文')
          ]
        },
        {
          buttons: [
            createButtonBase('查看指令表', '#chatgpt指令表', false),
            createButtonBase('查看帮助', '#chatgpt帮助'),
            createButtonBase('查看配置', '#chatgpt查看当前配置')
          ]
        },
        {
          buttons: [
            createButtonBase('查看模型列表', '#chatgpt模型列表'),
            createButtonBase('版本信息', '#chatgpt版本信息')
          ]
        }
      ]
    }
  }

  makeButtonEntertainment () {
    return {
      appid: 1,
      rows: [
        {
          buttons: [
            createButtonBase('今日词云', '#今日词云'),
            createButtonBase('最新词云', '#最新词云', false),
            createButtonBase('我的词云', '#我的今日词云')
          ]
        },
        {
          buttons: [
            createButtonBase('翻译', '#翻译', false),
            createButtonBase('OCR', '#ocr', false),
            createButtonBase('截图', '#url:', false)
          ]
        }
      ]
    }
  }
}

function createButtonBase (label, data, enter = true, style = 1) {
  return {
    id: '',
    render_data: {
      label,
      style,
      visited_label: label
    },
    action: {
      type: 2,
      permission: {
        type: 2
      },
      data,
      enter,
      unsupport_tips: ''
    }
  }
}
