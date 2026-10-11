// Protocol-shaped prose is never promoted into a tool call or silently stripped.
// Code examples and quoted discussion remain ordinary reply content.
const internalBlock = /^\s*<\/?(?:context_analysis|analysis|thinking|think|tool_wrapper(?:_[\w-]+)?|tool_call|function_call)(?:\s[^>]*|)>/iu

export function hasInternalReplyBlock (text: string): boolean {
  let fence: string | null = null
  let fenceLength = 0
  for (const line of text.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (marker !== null) {
      const token = marker[1]
      if (fence === null) { fence = token[0]; fenceLength = token.length }
      else if (token[0] === fence && token.length >= fenceLength && line.slice(marker[0].length).trim() === '') fence = null
      continue
    }
    if (fence === null && internalBlock.test(line)) return true
  }
  return false
}
