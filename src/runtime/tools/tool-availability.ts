import type { ToolRuntimeFacts } from '../../agent/tools/tool-context.js'
import type { ToolDefinition } from '../../agent/tools/tool-definition.js'

export const CONFIGURABLE_TOOL_NAMES = Object.freeze([
  'search', 'website', 'weather', 'github', 'queryUserinfo', 'queryGenshin', 'queryStarRail',
  'searchImage', 'searchVideo', 'searchMusic', 'imageCaption', 'draw', 'processPicture',
  'sendPicture', 'sendVideo', 'sendAvatar', 'sendMusic', 'sendAudioMessage', 'sendDice',
  'sendRPS', 'sendMessage', 'editCard', 'jinyan', 'kickOut', 'setTitle', 'handleMsg', 'randomChoice'
])

export function selectedTtsConfigured (config: Readonly<Record<string, unknown>>): boolean {
  const present = (key: string): boolean => typeof config[key] === 'string' && (config[key] as string).trim() !== ''
  if (config.ttsMode === 'azure') return present('azureTTSKey') && present('azureTTSRegion')
  if (config.ttsMode === 'voicevox') return present('voicevoxSpace')
  return (config.ttsMode === undefined || config.ttsMode === 'vits-uma-genshin-honkai') && present('ttsSpace')
}

// Discovery only removes impossible actions; execution still refreshes roles,
// checks the target/intent and enforces the original approval policy.
export function toolAvailableInScene (
  definition: ToolDefinition,
  facts: ToolRuntimeFacts,
  disabledTools: unknown
): boolean {
  if (Array.isArray(disabledTools) && disabledTools.includes(definition.name)) return false
  if (definition.effect !== 'side_effect') return true
  if (definition.permission === 'cross_channel') return true
  if (facts.channel.kind !== 'group' || !['owner', 'admin'].includes(facts.botGroupRole)) return false
  const actorManages = facts.actor.isBotMaster || ['owner', 'admin'].includes(facts.actorGroupRole)
  if (definition.name === 'setTitle') return facts.botGroupRole === 'owner' && actorManages
  if (definition.name === 'kickOut') return facts.actor.isBotMaster || facts.actorGroupRole === 'owner'
  // Members can still edit their own card and request <=60s self-mute.
  return ['editCard', 'jinyan'].includes(definition.name) || actorManages
}
