/** OICQ has no segment.music factory; OneBot accepts this standard segment. */
export function materializeYunzaiMusicSegment (
  segment: unknown,
  provider: '163',
  id: string
): unknown {
  if (!/^\d{1,32}$/.test(id) || provider !== '163') throw new TypeError('music share is invalid')
  if (segment !== null && (typeof segment === 'object' || typeof segment === 'function')) {
    const factory = Reflect.get(segment, 'music', segment)
    if (typeof factory === 'function') return Reflect.apply(factory, segment, [provider, id])
  }
  return { type: 'music', data: { type: provider, id } }
}
