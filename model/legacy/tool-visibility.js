const LEGACY_MANAGEMENT_TOOLS = new Set([
  'editCard',
  'jinyan',
  'kickOut',
  'setTitle',
  'handleMsg'
])

export function isLegacyToolExecutable ({ toolName, executableTools }) {
  return !LEGACY_MANAGEMENT_TOOLS.has(toolName) || Boolean(
    executableTools &&
    Object.hasOwn(executableTools, toolName) &&
    executableTools[toolName]
  )
}
