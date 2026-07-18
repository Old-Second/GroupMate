export function materializeYunzaiMagicSegment (
  segment: unknown,
  type: 'dice'
): unknown
export function materializeYunzaiMagicSegment (
  segment: unknown,
  type: 'rps',
  value: 1 | 2 | 3
): unknown
export function materializeYunzaiMagicSegment (
  segment: unknown,
  type: 'dice' | 'rps',
  value?: 1 | 2 | 3
): unknown {
  if (segment !== null && (typeof segment === 'object' || typeof segment === 'function')) {
    const factory = Reflect.get(segment, type, segment)
    if (typeof factory === 'function') {
      return Reflect.apply(factory, segment, type === 'dice' ? [] : [value])
    }
  }
  return { type, data: {} }
}
