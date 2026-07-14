import type { OpenAICompatibleProfile } from '../agent/model/openai-compatible-profile.js'
import { deepSeekCompatibilityProfile } from '../agent/model/deepseek-compatibility-profile.js'
import { standardOpenAIProfile } from '../agent/model/standard-openai-profile.js'

export type OpenAICompatibilityProfileId = 'standard' | 'deepseek'
export type OpenAICompatibilitySelectionSource = 'default' | 'explicit'

export interface OpenAICompatibleModelRuntimeConfigInput {
  readonly openAiCompatibilityProfile?: unknown
  readonly openAiBaseUrl?: unknown
  readonly model?: unknown
}

export interface OpenAICompatibleModelRuntimeConfig {
  readonly configuredProfile: OpenAICompatibilityProfileId
  readonly profile: OpenAICompatibleProfile
  readonly selectionSource: OpenAICompatibilitySelectionSource
}

const PROFILES: Readonly<Record<OpenAICompatibilityProfileId, OpenAICompatibleProfile>> =
  Object.freeze({
    standard: standardOpenAIProfile,
    deepseek: deepSeekCompatibilityProfile
  })

export function selectOpenAICompatibleProfile (value: unknown): OpenAICompatibleProfile {
  if (value !== 'standard' && value !== 'deepseek') {
    throw new TypeError('OpenAI compatibility profile must be standard or deepseek')
  }
  return PROFILES[value]
}

export function resolveOpenAICompatibleModelRuntimeConfig (
  input: OpenAICompatibleModelRuntimeConfigInput
): OpenAICompatibleModelRuntimeConfig {
  const explicit = Object.hasOwn(input, 'openAiCompatibilityProfile')
  const configuredProfile = explicit ? input.openAiCompatibilityProfile : 'standard'
  const profile = selectOpenAICompatibleProfile(configuredProfile)
  return Object.freeze({
    configuredProfile: profile.id as OpenAICompatibilityProfileId,
    profile,
    selectionSource: explicit ? 'explicit' : 'default'
  })
}
