export const CONFIGURABLE_TOOL_NAMES = Object.freeze([
    'search', 'website', 'weather', 'github', 'queryUserinfo', 'queryGenshin', 'queryStarRail',
    'searchImage', 'searchVideo', 'searchMusic', 'imageCaption', 'draw', 'processPicture',
    'sendPicture', 'sendVideo', 'sendAvatar', 'sendMusic', 'sendAudioMessage', 'sendDice',
    'sendRPS', 'sendMessage', 'editCard', 'jinyan', 'kickOut', 'setTitle', 'handleMsg', 'randomChoice',
    'dateTime', 'unitConvert', 'groupPoll', 'scheduledTask'
]);
export function selectedTtsConfigured(config) {
    const present = (key) => typeof config[key] === 'string' && config[key].trim() !== '';
    if (config.ttsMode === 'azure')
        return present('azureTTSKey') && present('azureTTSRegion');
    if (config.ttsMode === 'voicevox')
        return present('voicevoxSpace');
    return (config.ttsMode === undefined || config.ttsMode === 'vits-uma-genshin-honkai') && present('ttsSpace');
}
// Discovery only removes impossible actions; execution still refreshes roles,
// checks the target/intent and enforces the original approval policy.
export function toolAvailableInScene(definition, facts, disabledTools) {
    if (Array.isArray(disabledTools) && disabledTools.includes(definition.name))
        return false;
    if (definition.effect !== 'side_effect')
        return true;
    if (definition.name === 'groupPoll' || definition.name === 'scheduledTask') {
        return facts.channel.kind === 'group' && facts.actorGroupRole !== 'none' && facts.botGroupRole !== 'none';
    }
    if (definition.permission === 'cross_channel')
        return true;
    if (facts.channel.kind !== 'group' || !['owner', 'admin'].includes(facts.botGroupRole))
        return false;
    const actorManages = facts.actor.isBotMaster || ['owner', 'admin'].includes(facts.actorGroupRole);
    if (definition.name === 'setTitle')
        return facts.botGroupRole === 'owner' && actorManages;
    if (definition.name === 'kickOut')
        return facts.actor.isBotMaster || facts.actorGroupRole === 'owner';
    // Members can still edit their own card and request <=60s self-mute.
    return ['editCard', 'jinyan'].includes(definition.name) || actorManages;
}
