import { isLegacyToolExecutable } from './tool-visibility.js'

const LEGACY_TOOL_ALIASES = {
  mute: 'jinyan',
  ban: 'jinyan',
  jinyanTool: 'jinyan',
  kick: 'kickOut',
  kickout: 'kickOut'
}

export async function executeLegacyToolCall ({
  requestedName,
  fullFuncMap,
  executableTools,
  toolArgs,
  event,
  receiver,
  authorize = isLegacyToolExecutable
}) {
  const normalizedName = requestedName?.trim()
  const resolvedName = LEGACY_TOOL_ALIASES[normalizedName] || normalizedName
  const toolName = resolvedName || requestedName
  const tool = fullFuncMap[resolvedName]
  if (!tool?.exec) {
    return {
      toolName,
      outcome: 'unavailable',
      executed: false,
      result: `tool ${requestedName} is unavailable. Available tool names: ${Object.keys(fullFuncMap).join(', ')}`
    }
  }
  if (!authorize({ toolName: resolvedName, executableTools })) {
    return {
      toolName,
      outcome: 'denied',
      executed: false,
      result: `tool ${resolvedName} is unavailable in this chat scene or for the current requester permission`
    }
  }
  return {
    toolName,
    outcome: 'executed',
    executed: true,
    result: await tool.exec.call(receiver, toolArgs, event)
  }
}
