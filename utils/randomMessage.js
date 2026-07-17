import { Config } from './config.js'
import { completeAuxiliaryText } from '../dist/runtime/auxiliary-completion-service.js'

export async function generateHello () {
  const question = Config.helloPrompt || '写一段话让大家来找我聊天。类似于“有人找我聊天吗？"这种风格，轻松随意一点控制在20个字以内'
  return await completeAuxiliaryText({
    purpose: 'random_greeting',
    messages: [{ role: 'user', content: question }],
    maxOutputTokens: 128
  })
}
