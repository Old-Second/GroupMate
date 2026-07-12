export type PictureReplyResult = 'picture' | 'text-fallback'

export interface PictureReplyOperations {
  renderPicture: () => Promise<boolean>
  sendTextFallback: () => Promise<void>
  reportFailure: (error: unknown) => void
}

let renderTail: Promise<void> = Promise.resolve()

async function runSerially<T> (operation: () => Promise<T>): Promise<T> {
  const previous = renderTail
  let release!: () => void
  renderTail = new Promise<void>(resolve => {
    release = resolve
  })

  await previous
  try {
    return await operation()
  } finally {
    release()
  }
}

export async function presentPictureReply (
  operations: PictureReplyOperations
): Promise<PictureReplyResult> {
  let failure: unknown

  try {
    if (await runSerially(operations.renderPicture)) return 'picture'
    failure = Object.assign(new Error('Picture rendering returned no image'), {
      name: 'PictureRenderEmptyError',
      code: 'empty_result'
    })
  } catch (error) {
    failure = error
  }

  operations.reportFailure(failure)
  await operations.sendTextFallback()
  return 'text-fallback'
}
