export type CrossChannelAudience = 'disabled' | 'master' | 'everyone'

export interface CrossChannelAccess {
  readonly private: CrossChannelAudience
  readonly group: CrossChannelAudience
}

export function actorMaySendCrossChannel (
  access: CrossChannelAccess,
  targetKind: 'private' | 'group',
  isBotMaster: boolean
): boolean {
  const audience = access[targetKind]
  return audience === 'everyone' || (audience === 'master' && isBotMaster)
}
