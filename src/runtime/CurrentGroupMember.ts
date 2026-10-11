/** An execution boundary never falls back to the event or a member-list cache. */
export async function currentGroupMember (
  bot: Record<string, any>, groupId: string, userId: string, signal: AbortSignal
): Promise<Readonly<{ userId: string; role: 'owner' | 'admin' | 'member'; joinedAt: number }> | null> {
  if (signal.aborted) throw new DOMException('operation was aborted', 'AbortError')
  const controller = new AbortController()
  const abort = (): void => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort('member_lookup_timeout'), 1_000)
  const id = (value: string): string | number => Number.isSafeInteger(Number(value)) ? Number(value) : value
  try {
    const pending = (async (): Promise<unknown> => {
      if (typeof bot.sendApi === 'function') {
        return await bot.sendApi('get_group_member_info', { group_id: id(groupId), user_id: id(userId), no_cache: true })
      }
      if (typeof bot.getGroupMemberInfo === 'function') return await bot.getGroupMemberInfo(id(groupId), id(userId), true)
      const member = await bot.pickMember?.(id(groupId), id(userId))
      return typeof member?.getInfo === 'function' ? await member.getInfo(true) : null
    })()
    const raw = await Promise.race([pending, new Promise<null>(resolve => {
      controller.signal.addEventListener('abort', () => resolve(null), { once: true })
    })]) as Record<string, any> | null
    if (signal.aborted) throw new DOMException('operation was aborted', 'AbortError')
    if (raw === null || typeof raw !== 'object' || controller.signal.aborted ||
      (raw.retcode !== undefined && raw.retcode !== 0) || (raw.status !== undefined && raw.status !== 'ok')) return null
    const data = raw.data ?? raw
    if (String(data.user_id ?? data.userId ?? '') !== userId ||
      (data.group_id !== undefined && String(data.group_id) !== groupId) ||
      !['owner', 'admin', 'member'].includes(data.role)) return null
    const joinedAt = Number(data.join_time ?? data.joinTime)
    return Object.freeze({ userId, role: data.role,
      joinedAt: Number.isSafeInteger(joinedAt) && joinedAt > 0 ? joinedAt : 0 })
  } catch {
    if (signal.aborted) throw new DOMException('operation was aborted', 'AbortError')
    return null
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}
