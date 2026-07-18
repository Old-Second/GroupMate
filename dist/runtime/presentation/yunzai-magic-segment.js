export function materializeYunzaiMagicSegment(segment, type, value) {
    if (segment !== null && (typeof segment === 'object' || typeof segment === 'function')) {
        const factory = Reflect.get(segment, type, segment);
        if (typeof factory === 'function') {
            return Reflect.apply(factory, segment, type === 'dice' ? [] : [value]);
        }
    }
    return { type, data: {} };
}
