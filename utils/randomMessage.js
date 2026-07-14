import { Config } from './config.js'
import { createCompletionFacadeFromConfig } from '../dist/runtime/completion-facade.js'
import { newFetch } from './proxy.js'

export async function generateHello () {
  const question = Config.helloPrompt || '写一段话让大家来找我聊天。类似于“有人找我聊天吗？"这种风格，轻松随意一点控制在20个字以内'
  return await createCompletionFacadeFromConfig(Config, { fetch: newFetch }).completeText({
    purpose: 'random_greeting',
    messages: [{ role: 'user', content: question }],
    maxOutputTokens: 128
  }, new AbortController().signal)
}
