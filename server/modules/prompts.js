import { UserInfo } from './user_data.js'
import { Config } from '../../utils/config.js'
import { deleteOnePrompt, getPromptByName, readPrompts, saveOnePrompt } from '../../utils/prompts.js'

async function Prompt (fastify, options) {
  // 获取设定列表
  fastify.post('/getPromptList', async (request, reply) => {
    const token = request.cookies.token || request.body?.token || 'unknown'
    let user = UserInfo(token)
    if (!user) {
      reply.send({ err: '未登录' })
    } else if (user.autho === 'admin') {
      reply.send([
        {
          name: 'API默认',
          content: Config.promptPrefixOverride
        },
        ...readPrompts()
      ])
    } else {
      reply.send({ err: '权限不足' })
    }
    return reply
  })
  // 添加设定
  fastify.post('/addPrompt', async (request, reply) => {
    const token = request.cookies.token || request.body?.token || 'unknown'
    let user = UserInfo(token)
    if (!user) {
      reply.send({ err: '未登录' })
    } else if (user.autho === 'admin') {
      const body = request.body || {}
      if (body.prompt && body.content) {
        saveOnePrompt(body.prompt, body.content)
        reply.send({ state: true })
      } else {
        reply.send({ err: '参数不足' })
      }
    } else {
      reply.send({ err: '权限不足' })
    }
    return reply
  })
  // 删除设定
  fastify.post('/deletePrompt', async (request, reply) => {
    const token = request.cookies.token || request.body?.token || 'unknown'
    let user = UserInfo(token)
    if (!user) {
      reply.send({ err: '未登录' })
    } else if (user.autho === 'admin') {
      const body = request.body || {}
      if (body.prompt) {
        deleteOnePrompt(body.prompt)
        reply.send({ state: true })
      } else {
        reply.send({ err: '参数不足' })
      }
    } else {
      reply.send({ err: '权限不足' })
    }
    return reply
  })
  // 使用设定
  fastify.post('/usePrompt', async (request, reply) => {
    const token = request.cookies.token || request.body?.token || 'unknown'
    let user = UserInfo(token)
    if (!user) {
      reply.send({ err: '未登录' })
    } else if (user.autho === 'admin') {
      const body = request.body || {}
      if (body.prompt) {
        let promptName = body.prompt
        let prompt = getPromptByName(promptName)
        const use = 'api'
        if (!prompt) {
          if (promptName === 'API默认') {
            prompt = {
              name: 'API默认',
              content: Config.promptPrefixOverride
            }
          } else {
            prompt = false
            reply.send({ state: false, use, error: '未找到设定' })
          }
        }
        if (prompt) {
          Config.promptPrefixOverride = prompt.content
          await redis.set('CHATGPT:PROMPT_USE_api', promptName)
          reply.send({ state: true, use })
        }
      } else {
        reply.send({ err: '参数不足' })
      }
    } else {
      reply.send({ err: '权限不足' })
    }
    return reply
  })
}
export default Prompt
