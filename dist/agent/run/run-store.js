export class RunStoreConflictError extends Error {
    code;
    constructor() {
        super('run checkpoint revision conflict');
        this.name = 'RunStoreConflictError';
        this.code = 'checkpoint_conflict';
    }
}
