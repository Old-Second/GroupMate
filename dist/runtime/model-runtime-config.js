import { deepSeekCompatibilityProfile } from '../agent/model/deepseek-compatibility-profile.js';
import { standardOpenAIProfile } from '../agent/model/standard-openai-profile.js';
const PROFILES = Object.freeze({
    standard: standardOpenAIProfile,
    deepseek: deepSeekCompatibilityProfile
});
export function selectOpenAICompatibleProfile(value) {
    if (value !== 'standard' && value !== 'deepseek') {
        throw new TypeError('OpenAI compatibility profile must be standard or deepseek');
    }
    return PROFILES[value];
}
export function resolveOpenAICompatibleModelRuntimeConfig(input) {
    const explicit = Object.hasOwn(input, 'openAiCompatibilityProfile');
    const configuredProfile = explicit ? input.openAiCompatibilityProfile : 'standard';
    const profile = selectOpenAICompatibleProfile(configuredProfile);
    return Object.freeze({
        configuredProfile: profile.id,
        profile,
        selectionSource: explicit ? 'explicit' : 'default'
    });
}
