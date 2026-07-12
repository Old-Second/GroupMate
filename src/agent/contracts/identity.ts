export type ConversationScope =
  | { readonly kind: 'private'; readonly userId: string }
  | { readonly kind: 'group'; readonly groupId: string }
  | { readonly kind: 'group_user'; readonly groupId: string; readonly userId: string }

export interface SessionAddress {
  readonly botId: string
  readonly scope: ConversationScope
}

export interface ActorIdentity {
  readonly userId: string
  readonly displayName?: string
  readonly role: 'owner' | 'admin' | 'member'
}

export type ChannelIdentity =
  | { readonly kind: 'private'; readonly botId: string; readonly userId: string }
  | { readonly kind: 'group'; readonly botId: string; readonly groupId: string }
