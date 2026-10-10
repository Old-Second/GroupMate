// P8A diagnostic fence only. Authoritative membership/effect checks belong to P8B.
export function candidateFreshness(state, candidate) {
    try {
        return state.current(candidate);
    }
    catch {
        return 'unavailable';
    }
}
