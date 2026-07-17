export class YunzaiDiagnosticsController {
    #diagnostics;
    constructor(diagnostics) {
        this.#diagnostics = diagnostics;
    }
    async handleStatus(event) {
        const result = await this.#diagnostics.status({ authorized: event.authorized });
        await event.replyText(result.text);
        return true;
    }
    async handleInspect(event) {
        const result = await this.#diagnostics.inspect({
            authorized: event.authorized,
            runRef: event.commandArgument
        });
        await event.replyText(result.text);
        return true;
    }
}
