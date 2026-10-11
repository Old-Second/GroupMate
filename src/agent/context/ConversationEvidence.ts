/** Exact sentence boundaries and conservative qualification cues, never a fact classifier. */
export function conversationSentences (text: string): readonly string[] {
  return Object.freeze(text.match(/[^。！？\n]+[。！？]?/gu) ?? [])
}

export function isConversationQualification (text: string): boolean {
  return /(?:不|没|未|否|更正|改为|改成|取消|撤回|后来|其实|\b(?:not|never|no|correction|instead|changed)\b)/iu.test(text)
}
