import type {
  SessionPersistenceOutcome
} from '../agent/contracts/completion.js'
import type {
  PresentationRouteV1,
  RecoveredLegacyPresentationRoute
} from '../agent/contracts/interaction.js'
import type { RunAdvanceResult } from '../agent/contracts/result.js'
import type { FinalPresentationProfile } from './presentation/presentation-profile.js'
import type {
  CitationForward,
  PostprocessResult
} from './presentation/reply-content.js'
import { normalizeReasoningView } from './presentation/reply-content.js'
import type { PresentationSettings } from './presentation/presentation-settings.js'
import type { SafeTextAtom } from './presentation/yunzai-outbound-port.js'

export {
  UNAVAILABLE_TTS_REPLY_PORT
} from './presentation/yunzai-tts-reply-port.js'
export {
  UNAVAILABLE_GROUPMATE_PICTURE_RENDERER
} from './presentation/groupmate-picture-renderer.js'
export type {
  BrowserPicturePort,
  GroupMatePictureRenderer,
  Live2dAssetResolver
} from './presentation/groupmate-picture-renderer.js'
export type {
  TtsReplyPort,
  TtsSynthesisResult,
  TtsTargetEncodingPort,
  YunzaiTtsBackendPort
} from './presentation/yunzai-tts-reply-port.js'

export interface RuntimePresentationHooks {
  postprocess(input: { readonly text: string }): Promise<PostprocessResult>
  convertText(input: {
    readonly text: string
    readonly enableRobotAt: boolean
    readonly enableMarkdown: boolean
  }): Promise<readonly SafeTextAtom[]>
  notifyResponsePost(input: {
    readonly runRef: string
    readonly text: string
    readonly hasReasoning: boolean
  }): void
}

export interface RuntimeTextPostprocessor {
  processInner(input: {
    readonly text: string
    readonly thinking_text?: string
  }): Promise<{
    readonly text: string
    readonly thinking_text?: string
  }>
}

export interface RuntimePresentationHookAdapters {
  readonly loadPostprocessors: () => Promise<readonly RuntimeTextPostprocessor[]>
  readonly convertText: RuntimePresentationHooks['convertText']
  readonly notifyResponsePost: RuntimePresentationHooks['notifyResponsePost']
}

function normalizeText (value: string): string {
  return value.trim().normalize('NFC')
}

function separateInlineThinking (text: string): {
  readonly text: string
  readonly thinking: string
} {
  const blocks: string[] = []
  // 只摘掉 <think> 段本身；它之前和多段之间的正文都属于最终回复，不能丢。
  const body = text.replace(/<think>(.*?)<\/think>/gs, (_full: string, inner: string) => {
    blocks.push(inner)
    return ''
  })
  if (blocks.length === 0) return Object.freeze({ text, thinking: '' })
  return Object.freeze({ text: body, thinking: blocks.join('\n') })
}

export function createRuntimePresentationHooks (
  adapters: RuntimePresentationHookAdapters
): RuntimePresentationHooks {
  const hooks: RuntimePresentationHooks = {
    async postprocess ({ text }: { readonly text: string }): Promise<PostprocessResult> {
      let current = text
      let thinking = ''
      for (const processor of await adapters.loadPostprocessors()) {
        const output = await processor.processInner({
          text: current,
          ...(thinking === '' ? {} : { thinking_text: thinking })
        })
        current = typeof output.text === 'string' ? output.text : ''
        thinking = typeof output.thinking_text === 'string' ? output.thinking_text : thinking
      }
      const inline = separateInlineThinking(current)
      current = inline.text
      if (inline.thinking !== '') thinking += inline.thinking
      const reasoningView = normalizeReasoningView({
        text: thinking,
        truncated: false
      })
      return Object.freeze({
        text: normalizeText(current),
        ...(reasoningView === undefined ? {} : { reasoningView })
      })
    },
    convertText: async (input: {
      readonly text: string
      readonly enableRobotAt: boolean
      readonly enableMarkdown: boolean
    }) => Object.freeze([...(await adapters.convertText(input))]),
    notifyResponsePost: (input: {
      readonly runRef: string
      readonly text: string
      readonly hasReasoning: boolean
    }) => adapters.notifyResponsePost(input)
  }
  return Object.freeze(hooks)
}

export const PLAIN_TEXT_PRESENTATION_HOOKS: RuntimePresentationHooks = Object.freeze({
  postprocess: async ({ text }: { readonly text: string }) => {
    const inline = separateInlineThinking(text)
    const reasoningView = normalizeReasoningView({
      text: inline.thinking,
      truncated: false
    })
    return Object.freeze({
      text: normalizeText(inline.text),
      ...(reasoningView === undefined ? {} : { reasoningView })
    })
  },
  convertText: async ({ text }: {
    readonly text: string
    readonly enableRobotAt: boolean
    readonly enableMarkdown: boolean
  }) => Object.freeze([{ kind: 'text' as const, text }]),
  notifyResponsePost: () => undefined
})

export type FinalRunResult = Exclude<RunAdvanceResult, { kind: 'paused' }>

interface PresentationInputCommon {
  readonly result: FinalRunResult
  readonly sessionPersistence: SessionPersistenceOutcome
  readonly settings: PresentationSettings
  readonly citationForwards: readonly CitationForward[]
  readonly suggestions: readonly string[]
  readonly hooks: RuntimePresentationHooks
  readonly signal?: AbortSignal
}

export type PresentationInput =
  | PresentationInputCommon & {
      readonly route: Extract<PresentationRouteV1, { readonly requestKind: 'ordinary_chat' }>
      readonly profile: Extract<FinalPresentationProfile, { readonly kind: 'ordinary' }>
    }
  | PresentationInputCommon & {
      readonly route: Extract<PresentationRouteV1, { readonly requestKind: 'proactive_chat' }>
      readonly profile: Extract<FinalPresentationProfile, { readonly kind: 'proactive' }>
    }
  | PresentationInputCommon & {
      readonly route: RecoveredLegacyPresentationRoute
      readonly profile: Extract<
        FinalPresentationProfile,
        { readonly kind: 'recovered_legacy_plain_text' }
      >
    }
