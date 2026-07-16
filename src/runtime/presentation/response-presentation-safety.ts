export const POSTPROCESS_EMPTY_MESSAGE = '回复处理后没有可发送的正文，请重试'
export const BLOCKED_RESPONSE_MESSAGE = '返回内容存在敏感词，我不想回答你'
export const CANCELLED_MESSAGE = '任务已取消。'
export const SESSION_PERSISTENCE_FAILED_MESSAGE =
  '本轮结果已生成，但对话记录保存失败，后续对话可能无法延续本轮上下文。'

function containsBlockedWord (candidate: string, words: readonly string[]): boolean {
  const normalizedCandidate = candidate.normalize('NFC').toLowerCase()
  for (const word of words) {
    if (typeof word !== 'string') continue
    const normalizedWord = word.trim().normalize('NFC').toLowerCase()
    if (normalizedWord !== '' && normalizedCandidate.includes(normalizedWord)) return true
  }
  return false
}

export function promptIsBlocked (
  prompt: string,
  words: readonly string[]
): boolean {
  return containsBlockedWord(prompt, words)
}

export function responseIsBlocked (
  response: string,
  words: readonly string[]
): boolean {
  return containsBlockedWord(response, words)
}
