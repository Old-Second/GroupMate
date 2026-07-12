export function resolveLegacyConversationScope ({ isGroup, groupId, userId, groupMerge = false }) {
  if (!isGroup) return `private:${userId}`
  return groupMerge ? `group:${groupId}` : `group:${groupId}:user:${userId}`
}
