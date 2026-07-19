export function contextArtifactRefsRetainedOrCleared(previous, next) {
    if (next.length === 0)
        return true;
    return next.length === previous.length && next.every((ref, index) => (ref === previous[index]));
}
