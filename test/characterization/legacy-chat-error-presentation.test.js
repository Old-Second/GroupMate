import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('legacy chat delegates user-visible errors to the safe presentation policy', async () => {
  const source = await readFile(new URL('../../apps/chat.js', import.meta.url), 'utf8')
  const chatgpt1Index = source.indexOf('\n  async chatgpt1 (e)')
  const catchIndex = source.lastIndexOf('    } catch (err) {', chatgpt1Index)

  assert.ok(chatgpt1Index > 0, 'chatgpt1 boundary must exist')
  assert.ok(catchIndex > 0, 'final chat error branch must exist')

  const errorBranch = source.slice(catchIndex, chatgpt1Index)
  assert.match(
    source,
    /import \{ getChatErrorPresentation \} from '\.\.\/dist\/runtime\/chat-error-presentation\.js'/
  )
  assert.match(errorBranch, /const presentation = getChatErrorPresentation\(err\)/)
  assert.match(errorBranch, /category: presentation\.code/)
  assert.match(errorBranch, /if \(presentation\.resetConversation\)/)
  assert.match(errorBranch, /await this\.destroyConversations\(err\)/)
  assert.match(errorBranch, /await this\.reply\(presentation\.message, true\)/)
  assert.doesNotMatch(
    errorBranch,
    /err\?\.message|err\?\.data|JSON\.stringify\(err\)|renderImage|recallMsg/
  )
})
