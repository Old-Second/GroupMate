export function decideBymTrigger(input) {
    if (typeof input.message !== 'string' || input.message.trim() === '') {
        return Object.freeze({ prompt: null, explicitlyAddressed: false });
    }
    const prompt = input.message;
    if (input.recognizeLeadingAlias && input.hasLeadingAlias) {
        return Object.freeze({ prompt, explicitlyAddressed: true });
    }
    if (typeof input.assistantLabel !== 'string' || input.assistantLabel.trim() === '') {
        return Object.freeze({ prompt, explicitlyAddressed: false });
    }
    const message = prompt.trimStart();
    let index = message.indexOf(input.assistantLabel);
    while (index >= 0) {
        if (input.recognizeLeadingAlias || index > 0) {
            return Object.freeze({ prompt, explicitlyAddressed: true });
        }
        index = message.indexOf(input.assistantLabel, index + input.assistantLabel.length);
    }
    return Object.freeze({ prompt, explicitlyAddressed: false });
}
