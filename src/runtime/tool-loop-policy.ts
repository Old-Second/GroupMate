const SIDE_EFFECT_TOOL_NAMES = new Set([
  'editCard',
  'jinyan',
  'kickOut',
  'setTitle',
  'handleMsg',
  'sendPicture',
  'sendVideo',
  'sendAvatar',
  'sendMusic',
  'sendMessage',
  'sendDice',
  'sendAudioMessage',
  'sendRPS'
])

function isSuccessfulToolResult (result: unknown): boolean {
  const text = String(result || '').trim().toLowerCase()
  return Boolean(text) &&
    !text.startsWith('failed') &&
    !text.startsWith('you are not allowed') &&
    !text.startsWith('the user is not admin') &&
    !text.includes(' failed:') &&
    !text.includes('failed to ') &&
    !text.includes('cannot ')
}

export function shouldFinalizeAfterTool (name: unknown, result: unknown): boolean {
  return typeof name === 'string' &&
    SIDE_EFFECT_TOOL_NAMES.has(name) &&
    isSuccessfulToolResult(result)
}
