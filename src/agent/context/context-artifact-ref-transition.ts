export function contextArtifactRefsRetainedOrCleared (
  previous: readonly string[],
  next: readonly string[]
): boolean {
  if (next.length === 0) return true
  return next.length === previous.length && next.every((ref, index) => (
    ref === previous[index]
  ))
}
