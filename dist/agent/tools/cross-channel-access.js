export function actorMaySendCrossChannel(access, targetKind, isBotMaster) {
    const audience = access[targetKind];
    return audience === 'everyone' || (audience === 'master' && isBotMaster);
}
