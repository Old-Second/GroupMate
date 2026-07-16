import type { TrustedButtonRequest } from './yunzai-outbound-port.js'

export interface ReasoningView {
  readonly text: string
  readonly truncated: boolean
}

export interface CitationForward {
  readonly title: string
  readonly text: string
  readonly sourceUrl?: string
}

export interface PostprocessResult {
  readonly text: string
  readonly reasoningView?: ReasoningView
}

const EXACT_CONTROL_SUGGESTIONS = new Set([
  '开启确认',
  '关闭确认',
  '图片模式',
  '文本模式',
  '语音模式',
  '打招呼',
  '翻译帮助',
  '今日词云',
  '群友在聊什么',
  '最新词云',
  '我的今日词云'
])

const UPDATE_CONTROL = /^(?:groupmate|chatgpt(?:-plugin)?|gpt|chat|柴特寄批踢|柴特鸡批踢|柴特)(?:插件)?(?:强制)?更新$/iu
const COMMAND_TABLE_CONTROL = /^chatgpt(?:对话|管理|娱乐|绘图|人物设定|聊天记录)?指令表(?:帮助|搜索[\s\S]*)?$/iu
const CONVERSATION_CONTROL = /^(?:[^\s#]{1,32})?(?:结束|新开|摧毁|毁灭|完结)(?:全部)?对话(?:\s+@\S+)?$/u
const KEYCAP_EMOJI = /^[#*0-9]\uFE0F?\u20E3$/u
const FLAG_EMOJI = /^\p{Regional_Indicator}{2}$/u
const PICTOGRAPHIC_EMOJI = /\p{Extended_Pictographic}/u
const GRAPHEME_SEGMENTER = new Intl.Segmenter('und', { granularity: 'grapheme' })

function trimNfc (value: string): string {
  return value.trim().normalize('NFC')
}

function truncateCodePoints (value: string, maximum: number): string {
  const points = [...value]
  return points.length <= maximum ? value : points.slice(0, maximum).join('')
}

function safeHttpUrl (value: string): string | null {
  const normalized = trimNfc(value)
  if (Buffer.byteLength(normalized, 'utf8') > 2_048) return null
  try {
    const parsed = new URL(normalized)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? normalized
      : null
  } catch {
    return null
  }
}

function isEmojiGrapheme (value: string): boolean {
  return KEYCAP_EMOJI.test(value) || FLAG_EMOJI.test(value) || PICTOGRAPHIC_EMOJI.test(value)
}

function isDoubleEmojiControl (value: string): boolean {
  const graphemes = [...GRAPHEME_SEGMENTER.segment(value)].map(item => item.segment)
  return graphemes.length === 2 && graphemes.every(isEmojiGrapheme)
}

function controlSuggestion (value: string): boolean {
  const lower = value.toLowerCase()
  if (value.startsWith('#') || value === '确认' || value === '拒绝') return true
  if (EXACT_CONTROL_SUGGESTIONS.has(value)) return true
  return UPDATE_CONTROL.test(value) ||
    COMMAND_TABLE_CONTROL.test(value) ||
    CONVERSATION_CONTROL.test(value) ||
    isDoubleEmojiControl(value) ||
    /^(?:groupmate|chatgpt)(?:开启|关闭)确认$/i.test(value) ||
    /^(?:groupmate|chatgpt)(?:图片|文本|语音)模式$/i.test(value) ||
    /^(?:groupmate|chatgpt)(?:打招呼|翻译帮助)$/i.test(value) ||
    lower === 'confirm' || lower === 'reject'
}

export function normalizeCitationForwards (
  values: readonly CitationForward[]
): readonly CitationForward[] {
  const result: CitationForward[] = []
  for (const value of values) {
    if (result.length >= 16) break
    if (value === null || typeof value !== 'object') continue
    if (typeof value.title !== 'string' || typeof value.text !== 'string') continue
    const title = truncateCodePoints(trimNfc(value.title), 200)
    const text = truncateCodePoints(trimNfc(value.text), 4_000)
    if (title === '' || text === '') continue
    let sourceUrl: string | undefined
    if (value.sourceUrl !== undefined) {
      if (typeof value.sourceUrl !== 'string') continue
      const parsed = safeHttpUrl(value.sourceUrl)
      if (parsed === null) continue
      sourceUrl = parsed
    }
    result.push(Object.freeze({
      title,
      text,
      ...(sourceUrl === undefined ? {} : { sourceUrl })
    }))
  }
  return Object.freeze(result)
}

export function normalizeSuggestions (
  values: readonly string[]
): readonly string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (result.length >= 6) break
    if (typeof value !== 'string') continue
    const normalized = trimNfc(value)
    if (normalized === '' || /[\r\n]/.test(normalized)) continue
    const bounded = truncateCodePoints(normalized, 80)
    if (controlSuggestion(bounded) || seen.has(bounded)) continue
    seen.add(bounded)
    result.push(bounded)
  }
  return Object.freeze(result)
}

export function buildChatSuggestionButtonRequest (
  suggestions: readonly string[]
): TrustedButtonRequest | undefined {
  const normalized = normalizeSuggestions(suggestions)
  if (normalized.length === 0) return undefined
  return Object.freeze({
    schemaVersion: 1,
    kind: 'chat_suggestions',
    suggestions: normalized
  })
}

export function normalizeReasoningView (
  value: ReasoningView | undefined
): ReasoningView | undefined {
  if (value === undefined || typeof value.text !== 'string' || typeof value.truncated !== 'boolean') {
    return undefined
  }
  const normalized = trimNfc(value.text)
  if (normalized === '') return undefined
  const points = [...normalized]
  const wasTruncated = points.length > 2_000
  return Object.freeze({
    text: wasTruncated ? points.slice(0, 2_000).join('') : normalized,
    truncated: value.truncated || wasTruncated
  })
}
