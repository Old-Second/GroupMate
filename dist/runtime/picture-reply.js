let renderTail = Promise.resolve();
async function runSerially(operation) {
    const previous = renderTail;
    let release;
    renderTail = new Promise(resolve => {
        release = resolve;
    });
    await previous;
    try {
        return await operation();
    }
    finally {
        release();
    }
}
export async function presentPictureReply(operations) {
    let failure;
    try {
        if (await runSerially(operations.renderPicture))
            return 'picture';
        failure = Object.assign(new Error('Picture rendering returned no image'), {
            name: 'PictureRenderEmptyError',
            code: 'empty_result'
        });
    }
    catch (error) {
        failure = error;
    }
    operations.reportFailure(failure);
    await operations.sendTextFallback();
    return 'text-fallback';
}
