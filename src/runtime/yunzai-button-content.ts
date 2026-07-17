import type { TrustedButtonRequest } from './presentation/yunzai-outbound-port.js'

export interface ButtonPolicySnapshot {
  readonly markdownEnabled: boolean
  readonly openAiConfigured: boolean
}

export interface ButtonCompatibilityPort {
  snapshot(): ButtonPolicySnapshot
}

export interface YunzaiButton {
  readonly id: ''
  readonly render_data: {
    readonly label: string
    readonly style: 1
    readonly visited_label: string
  }
  readonly action: {
    readonly type: 2
    readonly permission: { readonly type: 2 }
    readonly data: string
    readonly enter: boolean
    readonly unsupport_tips: ''
  }
}

export interface YunzaiButtonContent {
  readonly appid: 1
  readonly rows: readonly {
    readonly buttons: readonly YunzaiButton[]
  }[]
}

function button (label: string, data: string, enter = true): YunzaiButton {
  return Object.freeze({
    id: '',
    render_data: Object.freeze({
      label,
      style: 1,
      visited_label: label
    }),
    action: Object.freeze({
      type: 2,
      permission: Object.freeze({ type: 2 }),
      data,
      enter,
      unsupport_tips: ''
    })
  })
}

function content (rows: readonly (readonly YunzaiButton[])[]): YunzaiButtonContent {
  return Object.freeze({
    appid: 1,
    rows: Object.freeze(rows.map(buttons => Object.freeze({
      buttons: Object.freeze([...buttons])
    })))
  })
}

export function buildChatButtonContent (
  request: TrustedButtonRequest | undefined,
  policy: ButtonPolicySnapshot
): YunzaiButtonContent | null {
  if (!policy.markdownEnabled) return null
  const rows: (readonly YunzaiButton[])[] = []
  if (request?.schemaVersion === 1 && request.kind === 'chat_suggestions' &&
    Array.isArray(request.suggestions)) {
    const suggestions = request.suggestions.slice(0, 6)
    if (suggestions.length > 0) {
      rows.push(suggestions.map(suggestion => button(suggestion, suggestion)))
    }
  }
  rows.push([
    button('结束对话', '#毁灭对话'),
    button('结束当前对话', '#api结束对话'),
    button('at我对话', '', false)
  ])
  if (policy.openAiConfigured) {
    rows.push([button('OpenAI-compatible', '#chat1', false)])
  }
  return content(rows)
}

export function buildEndButtonContent (): YunzaiButtonContent {
  return content([[
    button('重新开始', '#摧毁对话'),
    button('全部结束', '#摧毁全部对话'),
    button('开始对话', '#chat1', false)
  ]])
}

export function buildModeButtonContent (): YunzaiButtonContent {
  return content([[
    button('以文字回复', '#chatgpt文本模式'),
    button('以图片回复', '#chatgpt图片模式'),
    button('以语音回复', '#chatgpt语音模式')
  ]])
}

export function buildConfirmButtonContent (): YunzaiButtonContent {
  return content([
    [
      button('开启确认', '#chatgpt开启确认'),
      button('关闭确认', '#chatgpt关闭确认'),
      button('暂停本群回复', '#chatgpt本群闭嘴', false)
    ],
    [
      button('恢复本群回复', '#chatgpt本群张嘴', false),
      button('开启上下文', '#打开群聊上下文'),
      button('关闭上下文 ', '#关闭群聊上下文')
    ],
    [
      button('查看指令表', '#chatgpt指令表', false),
      button('查看帮助', '#chatgpt帮助'),
      button('查看配置', '#chatgpt查看当前配置')
    ],
    [
      button('查看模型列表', '#chatgpt模型列表'),
      button('版本信息', '#chatgpt版本信息')
    ]
  ])
}

export function buildEntertainmentButtonContent (): YunzaiButtonContent {
  return content([
    [
      button('今日词云', '#今日词云'),
      button('最新词云', '#最新词云', false),
      button('我的词云', '#我的今日词云')
    ],
    [
      button('翻译', '#翻译', false),
      button('OCR', '#ocr', false),
      button('截图', '#url:', false)
    ]
  ])
}
