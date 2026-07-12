export interface AbortOptions { readonly signal?: AbortSignal }
export interface SaveOptions extends AbortOptions { readonly ttlSeconds?: number }
export interface ListOptions extends AbortOptions { readonly limit?: number }
