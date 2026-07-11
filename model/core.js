import { Config, defaultOpenAIAPI } from '../utils/config.js'
import {
  extractContentFromFile,
  formatDate,
  getImg,
  getMasterQQ, getMaxModelTokens,
  getUin,
  getUserData,
  isCN
} from '../utils/common.js'
import { KeyvFile } from 'keyv-file'
import SydneyAIClient from '../utils/SydneyAIClient.js'
import { getChatHistoryGroup } from '../utils/chat.js'
import { APTool } from '../utils/tools/APTool.js'
import { OfficialChatGPTClient } from '../utils/message.js'
import { ClaudeAPIClient } from '../client/ClaudeAPIClient.js'
import { ClaudeAIClient } from '../utils/claude.ai/index.js'
import XinghuoClient from '../utils/xinghuo/xinghuo.js'
import { getMessageById, upsertMessage } from '../utils/history.js'
import { v4 as uuid } from 'uuid'
import fetch from 'node-fetch'
import { CustomGoogleGeminiClient } from '../client/CustomGoogleGeminiClient.js'
import { QueryStarRailTool } from '../utils/tools/QueryStarRailTool.js'
import { WebsiteTool } from '../utils/tools/WebsiteTool.js'
import { SendPictureTool } from '../utils/tools/SendPictureTool.js'
import { SendVideoTool } from '../utils/tools/SendBilibiliTool.js'
import { SearchVideoTool } from '../utils/tools/SearchBilibiliTool.js'
import { SendAvatarTool } from '../utils/tools/SendAvatarTool.js'
import { SerpImageTool } from '../utils/tools/SearchImageTool.js'
import { SearchMusicTool } from '../utils/tools/SearchMusicTool.js'
import { SendMusicTool } from '../utils/tools/SendMusicTool.js'
import { SendAudioMessageTool } from '../utils/tools/SendAudioMessageTool.js'
import { SendMessageToSpecificGroupOrUserTool } from '../utils/tools/SendMessageToSpecificGroupOrUserTool.js'
import { QueryGenshinTool } from '../utils/tools/QueryGenshinTool.js'
import { WeatherTool } from '../utils/tools/WeatherTool.js'
import { QueryUserinfoTool } from '../utils/tools/QueryUserinfoTool.js'
import { EditCardTool } from '../utils/tools/EditCardTool.js'
import { JinyanTool } from '../utils/tools/JinyanTool.js'
import { KickOutTool } from '../utils/tools/KickOutTool.js'
import { SetTitleTool } from '../utils/tools/SetTitleTool.js'
import { SerpIkechan8370Tool } from '../utils/tools/SerpIkechan8370Tool.js'
import { SerpTool } from '../utils/tools/SerpTool.js'
import { TavilySearchTool } from '../utils/tools/TavilySearchTool.js'
import common from '../../../lib/common/common.js'
import { SendDiceTool } from '../utils/tools/SendDiceTool.js'
import { SendRPSTool } from '../utils/tools/SendRPSTool.js'
// import { EliMovieTool } from '../utils/tools/EliMovieTool.js'
// import { EliMusicTool } from '../utils/tools/EliMusicTool.js'
import { HandleMessageMsgTool } from '../utils/tools/HandleMessageMsgTool.js'
import { ProcessPictureTool } from '../utils/tools/ProcessPictureTool.js'
import { ImageCaptionTool } from '../utils/tools/ImageCaptionTool.js'
import { ChatGPTAPI } from '../utils/openai/chatgpt-api.js'
import { newFetch } from '../utils/proxy.js'
import { ChatGLM4Client } from '../client/ChatGLM4Client.js'
import { QwenApi } from '../utils/alibaba/qwen-api.js'
import { BingAIClient } from '../client/CopilotAIClient.js'
import Keyv from 'keyv'
import crypto from 'crypto'
import {GithubAPITool} from '../utils/tools/GithubTool.js'

export const roleMap = {
  owner: 'group owner',
  admin: 'group administrator'
}

const defaultPropmtPrefix = ', a large language model trained by OpenAI. You answer as concisely as possible for each response (e.g. don’t be verbose). It is very important that you answer as concisely as possible, so please remember this. If you are generating a list, do not have too many items. Keep the number of items short.'
const MAX_SMART_TOOL_CALLS = 8
const MAX_TOOL_RESULT_TRACE_LENGTH = 4000
const SIDE_EFFECT_TOOL_NAMES = new Set([
  'editCard',
  'jinyan',
  'kickOut',
  'setTitle',
  'sendPicture',
  'sendVideo',
  'sendAvatar',
  'sendMusic',
  'sendMessage',
  'sendDice',
  'sendAudioMessage',
  'sendRPS'
])
const MANAGEMENT_TOOL_NAMES = new Set([
  'editCard',
  'jinyan',
  'kickOut',
  'setTitle',
  'handleMsg'
])

function getConversationScope (e, userId = e.sender?.user_id) {
  if (e.isGroup) {
    return Config.groupMerge ? `group:${e.group_id}` : `group:${e.group_id}:user:${userId}`
  }
  return `private:${userId}`
}

async function getRequesterGroupRole (e, userId = e.sender?.user_id) {
  if (!e.isGroup) {
    return undefined
  }
  try {
    const members = await e.group?.getMemberMap?.()
    return members?.get(Number(userId))?.role || members?.get(String(userId))?.role || e.sender?.role
  } catch (err) {
    return e.sender?.role
  }
}

async function isRequesterMaster (e, userId = e.sender?.user_id) {
  const masters = await getMasterQQ()
  return Array.isArray(masters) && masters.map(item => String(item)).includes(String(userId))
}

function isManagementToolAvailable (funcMap, toolName) {
  return !MANAGEMENT_TOOL_NAMES.has(toolName) || Boolean(funcMap[toolName])
}

function disableFunctionCalling (completionParams = {}) {
  delete completionParams.functions
  if (completionParams.parameters) {
    delete completionParams.parameters.tools
  }
}

function truncateToolTrace (text) {
  text = typeof text === 'string' ? text : JSON.stringify(text)
  text = text || ''
  return text.length > MAX_TOOL_RESULT_TRACE_LENGTH ? `${text.slice(0, MAX_TOOL_RESULT_TRACE_LENGTH)}...` : text
}

function appendReasoningTrace (trace, msg, label) {
  const thinking = msg?.thinking_text?.trim()
  if (thinking) {
    trace.push(`【${label}】\n${thinking}`)
  }
}

function appendToolTrace (trace, name, args, result) {
  let argsText = ''
  try {
    argsText = JSON.stringify(args)
  } catch (err) {
    argsText = String(args)
  }
  trace.push(`【工具调用：${name}】\n参数：${truncateToolTrace(argsText)}\n结果：${truncateToolTrace(result)}`)
}

function finalizeSmartTrace (msg, trace) {
  if (msg && trace.length > 0) {
    if (!msg.raw_thinking_text && msg.thinking_text) {
      msg.raw_thinking_text = msg.thinking_text
    }
    msg.thinking_segments = trace
    msg.thinking_text = trace.join('\n\n')
  }
  return msg
}

function resolveToolCall (fullFuncMap, name) {
  const normalizedName = name?.trim()
  const aliases = {
    mute: 'jinyan',
    ban: 'jinyan',
    jinyanTool: 'jinyan',
    kick: 'kickOut',
    kickout: 'kickOut'
  }
  const resolvedName = aliases[normalizedName] || normalizedName
  return {
    name: resolvedName,
    tool: fullFuncMap[resolvedName]
  }
}

function isSuccessfulToolResult (result) {
  const text = String(result || '').trim().toLowerCase()
  return Boolean(text) &&
    !text.startsWith('failed') &&
    !text.startsWith('you are not allowed') &&
    !text.startsWith('the user is not admin') &&
    !text.includes(' failed:') &&
    !text.includes('failed to ') &&
    !text.includes('cannot ')
}

function shouldFinalizeAfterTool (name, result) {
  return SIDE_EFFECT_TOOL_NAMES.has(name) && isSuccessfulToolResult(result)
}

async function handleSystem (e, system, settings) {
  if (settings.enableGroupContext) {
    try {
      let opt = {}
      opt.groupId = e.group_id
      opt.qq = e.sender.user_id
      opt.nickname = e.sender.card
      opt.groupName = e.group.name || e.group_name
      opt.botName = e.isGroup ? (e.group.pickMember(getUin(e)).card || e.group.pickMember(getUin(e)).nickname) : e.bot.nickname
      let master = (await getMasterQQ())[0]
      if (master && e.group) {
        opt.masterName = e.group.pickMember(parseInt(master)).card || e.group.pickMember(parseInt(master)).nickname
      }
      if (master && !e.group) {
        opt.masterName = e.bot.getFriendList().get(parseInt(master))?.nickname
      }
      let chats = await getChatHistoryGroup(e, Config.groupContextLength)
      opt.chats = chats
      const namePlaceholder = '[name]'
      const defaultBotName = 'ChatGPT'
      const groupContextTip = Config.groupContextTip
      system = system.replaceAll(namePlaceholder, opt.botName || defaultBotName) +
        ((opt.groupId) ? groupContextTip : '')
      system += 'Attention, you are currently chatting in a qq group, then one who asks you now is' + `${opt.nickname}(${opt.qq})。`
      system += `the group name is ${opt.groupName}, group id is ${opt.groupId}。`
      if (opt.botName) {
        system += `Your nickname is ${opt.botName} in the group,`
      }
      if (chats) {
        system += 'There is the conversation history in the group, you must chat according to the conversation history context"'
        system += chats
          .map(chat => {
            let sender = chat.sender || {}
            // if (sender.user_id === e.bot.uin && chat.raw_message.startsWith('建议的回复')) {
            if (chat.raw_message.startsWith('建议的回复')) {
              // 建议的回复太容易污染设定导致对话太固定跑偏了
              return ''
            }
            return `【${sender.card || sender.nickname}】(qq：${sender.user_id}, ${roleMap[sender.role] || 'normal user'}，${sender.area ? 'from ' + sender.area + ', ' : ''} ${sender.age} years old, 群头衔：${sender.title}, gender: ${sender.sex}, time：${formatDate(new Date(chat.time * 1000))}, messageId: ${chat.message_id}) 说：${chat.raw_message}`
          })
          .join('\n')
      }
    } catch (err) {
      if (e.isGroup) {
        logger.warn('获取群聊聊天记录失败，本次对话不携带聊天记录', err)
      }
    }
  }
  return system
}

class Core {
  async sendMessage (prompt, conversation = {}, use, e, opt = {
    enableSmart: Config.smartMode,
    system: {
      api: Config.promptPrefixOverride,
      qwen: Config.promptPrefixOverride,
      bing: Config.sydney,
      claude: Config.claudeSystemPrompt,
      claude2: Config.claudeSystemPrompt,
      gemini: Config.geminiPrompt,
      xh: Config.xhPrompt
    },
    settings: {
      replyPureTextCallback: undefined,
      enableGroupContext: Config.enableGroupContext,
      forceTool: false
    }
  }) {
    if (!conversation) {
      conversation = {
        timeoutMs: Config.defaultTimeoutMs
      }
    }
    if (Config.debug) {
      logger.mark(`using ${use} mode`)
    }
    const userData = await getUserData(e.user_id)
    const useCast = userData.cast || {}
    if (use === 'bing') {
      const cacheOptions = {
        namespace: Config.toneStyle,
        store: new KeyvFile({ filename: 'cache.json' })
      }
      const conversationsCache = new Keyv(cacheOptions)
      let client = new BingAIClient(Config.bingAiToken, Config.sydneyReverseProxy, Config.debug, Config._2captchaKey, Config.bingAiClientId, Config.bingAiScope, Config.bingAiRefreshToken, Config.bingAiOid, Config.bingReasoning)
      const conversationKey = `SydneyUser_${e.sender.user_id}`
      const conversations = (await conversationsCache.get(conversationKey)) || {
        messages: [],
        createdAt: Date.now()
      }
      if (Config.debug) {
        logger.debug(JSON.stringify(conversations))
      }
      const previousCachedMessages = SydneyAIClient.getMessagesForConversation(conversations.messages, conversation.parentMessageId)
        .map((message) => {
          return {
            text: message.message,
            author: message.role === 'User' ? 'user' : 'bot'
          }
        })
      let system = opt.system.bing
      if (opt.settings.enableGroupContext && e.isGroup) {
        let chats = await getChatHistoryGroup(e, Config.groupContextLength)
        const namePlaceholder = '[name]'
        const defaultBotName = 'Copilot'
        const groupContextTip = Config.groupContextTip
        let botName = e.isGroup ? (e.group.pickMember(getUin(e)).card || e.group.pickMember(getUin(e)).nickname) : e.bot.nickname
        system = system.replaceAll(namePlaceholder, botName || defaultBotName) +
          ((opt.settings.enableGroupContext && e.group_id) ? groupContextTip : '')
        system += 'Attention, you are currently chatting in a qq group, then one who asks you now is' + `${e.sender.card || e.sender.nickname}(${e.sender.user_id}).`
        system += `the group name is ${e.group.name || e.group_name}, group id is ${e.group_id}.`
        system += `Your nickname is ${botName} in the group,`
        if (chats) {
          system += 'There is the conversation history in the group, you must chat according to the conversation history context"'
          system += chats
            .map(chat => {
              let sender = chat.sender || {}
              return `【${sender.card || sender.nickname}】(qq：${sender.user_id}, ${roleMap[sender.role] || 'normal user'}，${sender.area ? 'from ' + sender.area + ', ' : ''} ${sender.age} years old, 群头衔：${sender.title}, gender: ${sender.sex}, time：${formatDate(new Date(chat.time * 1000))}, messageId: ${chat.message_id}) 说：${chat.raw_message}`
            })
            .join('\n')
        }
      }
      const msg = `System:\n${system}\n\nPrevious Messages:\n${JSON.stringify(previousCachedMessages)}\n\nUser: ${prompt}`
      const response = await client.sendMessage(msg)
      logger.info({ response })
      const userMessage = {
        id: crypto.randomUUID(),
        parentMessageId: conversation.parentMessageId,
        role: 'User',
        message: prompt
      }
      conversations.messages.push(userMessage)
      const replyMessage = {
        id: crypto.randomUUID(),
        parentMessageId: userMessage.id,
        role: 'Bing',
        message: response
      }
      conversations.messages.push(replyMessage)
      await conversationsCache.set(conversationKey, conversations)
      return {
        text: response,
        parentMessageId: replyMessage.id

      }
    } else if (use === 'api3') {
      // official without cloudflare
      let accessToken = await redis.get('CHATGPT:TOKEN')
      // if (!accessToken) {
      //   throw new Error('未绑定ChatGPT AccessToken，请使用#chatgpt设置token命令绑定token')
      // }
      this.chatGPTApi = new OfficialChatGPTClient({
        accessToken,
        apiReverseUrl: Config.api,
        timeoutMs: 120000
      })
      let sendMessageResult = await this.chatGPTApi.sendMessage(prompt, conversation)
      // 更新最后一条prompt
      await redis.set(`CHATGPT:CONVERSATION_LAST_MESSAGE_PROMPT:${sendMessageResult.conversationId}`, prompt)
      // 更新最后一条messageId
      await redis.set(`CHATGPT:CONVERSATION_LAST_MESSAGE_ID:${sendMessageResult.conversationId}`, sendMessageResult.id)
      await redis.set(`CHATGPT:QQ_CONVERSATION:${getConversationScope(e)}`, sendMessageResult.conversationId)
      if (!conversation.conversationId) {
        // 如果是对话的创建者
        await redis.set(`CHATGPT:CONVERSATION_CREATER_ID:${sendMessageResult.conversationId}`, e.sender.user_id)
        await redis.set(`CHATGPT:CONVERSATION_CREATER_NICK_NAME:${sendMessageResult.conversationId}`, e.sender.card)
      }
      (async () => {
        let audio = await this.chatGPTApi.synthesis(sendMessageResult)
        if (audio) {
          await e.reply(segment.record(audio))
        }
      })().catch(err => {
        logger.warn('发送语音失败', err)
      })
      return sendMessageResult
    } else if (use === 'claude') {
      // slack已经不可用，移除
      let keys = Config.claudeApiKey?.split(/[,;]/).map(key => key.trim()).filter(key => key)
      let choiceIndex = Math.floor(Math.random() * keys.length)
      let key = keys[choiceIndex]
      logger.info(`使用API Key：${key}`)
      while (keys.length >= 0) {
        let errorMessage = ''
        const client = new ClaudeAPIClient({
          key,
          model: Config.claudeApiModel || 'claude-3-sonnet-20240229',
          debug: true,
          baseUrl: Config.claudeApiBaseUrl
        })
        let option = {
          stream: false,
          parentMessageId: conversation.parentMessageId,
          conversationId: conversation.conversationId,
          system: opt.system.claude,
          max_tokens: Config.apiMaxToken
        }
        if (opt.settings.enableGroupContext && e.isGroup) {
          let chats = await getChatHistoryGroup(e, Config.groupContextLength)
          const namePlaceholder = '[name]'
          const defaultBotName = 'GeminiPro'
          const groupContextTip = Config.groupContextTip
          let botName = e.isGroup ? (e.group.pickMember(getUin(e)).card || e.group.pickMember(getUin(e)).nickname) : e.bot.nickname
          option.system = option.system.replaceAll(namePlaceholder, botName || defaultBotName) +
            ((opt.settings.enableGroupContext && e.group_id) ? groupContextTip : '')
          option.system += 'Attention, you are currently chatting in a qq group, then one who asks you now is' + `${e.sender.card || e.sender.nickname}(${e.sender.user_id}).`
          option.system += `the group name is ${e.group.name || e.group_name}, group id is ${e.group_id}.`
          option.system += `Your nickname is ${botName} in the group,`
          if (chats) {
            option.system += 'There is the conversation history in the group, you must chat according to the conversation history context"'
            option.system += chats
              .map(chat => {
                let sender = chat.sender || {}
                return `【${sender.card || sender.nickname}】(qq：${sender.user_id}, ${roleMap[sender.role] || 'normal user'}，${sender.area ? 'from ' + sender.area + ', ' : ''} ${sender.age} years old, 群头衔：${sender.title}, gender: ${sender.sex}, time：${formatDate(new Date(chat.time * 1000))}, messageId: ${chat.message_id}) 说：${chat.raw_message}`
              })
              .join('\n')
          }
        }
        let img = await getImg(e)
        if (img && img.length > 0) {
          const response = await fetch(img[0])
          const base64Image = Buffer.from(await response.arrayBuffer()).toString('base64')
          opt.image = base64Image
        }
        try {
          let rsp = await client.sendMessage(prompt, option)
          return rsp
        } catch (err) {
          errorMessage = err.message
          switch (err.message) {
            case 'rate_limit_error': {
              // api没钱了或者当月/日/时/分额度耗尽
              // throw new Error('claude API额度耗尽或触发速率限制')
              break
            }
            case 'authentication_error': {
              // 无效的key
              // throw new Error('claude API key无效')
              break
            }
            default:
          }
          logger.warn(`claude api 错误：[${key}] ${errorMessage}`)
        }
        if (keys.length === 0) {
          throw new Error(errorMessage)
        }
        keys.splice(choiceIndex, 1)
        choiceIndex = Math.floor(Math.random() * keys.length)
        key = keys[choiceIndex]
        logger.info(`使用API Key：${key}`)
      }
    } else if (use === 'claude2') {
      let { conversationId } = conversation
      let client = new ClaudeAIClient({
        organizationId: Config.claudeAIOrganizationId,
        sessionKey: Config.claudeAISessionKey,
        debug: Config.debug,
        proxy: Config.proxy
      })
      let toSummaryFileContent
      try {
        if (e.source) {
          let msgs = e.isGroup ? await e.group.getChatHistory(e.source.seq, 1) : await e.friend.getChatHistory(e.source.time, 1)
          let sourceMsg = msgs[0]
          let fileMsgElem = sourceMsg.message.find(msg => msg.type === 'file')
          if (fileMsgElem) {
            toSummaryFileContent = await extractContentFromFile(fileMsgElem, e)
          }
        }
      } catch (err) {
        logger.warn('读取文件内容出错， 忽略文件内容', err)
      }

      let attachments = []
      if (toSummaryFileContent?.content) {
        attachments.push({
          extracted_content: toSummaryFileContent.content,
          file_name: toSummaryFileContent.name,
          file_type: 'pdf',
          file_size: 200312,
          totalPages: 20
        })
        logger.info(toSummaryFileContent.content)
      }
      if (conversationId) {
        return await client.sendMessage(prompt, conversationId, attachments)
      } else {
        let conv = await client.createConversation()
        return await client.sendMessage(prompt, conv.uuid, attachments)
      }
    } else if (use === 'xh') {
      const cacheOptions = {
        namespace: 'xh',
        store: new KeyvFile({ filename: 'cache.json' })
      }
      const ssoSessionId = Config.xinghuoToken
      if (!ssoSessionId) {
        // throw new Error('未绑定星火token，请使用#chatgpt设置星火token命令绑定token。（获取对话页面的ssoSessionId cookie值）')
        logger.warn('未绑定星火token，请使用#chatgpt设置星火token命令绑定token。（获取对话页面的ssoSessionId cookie值）')
      }
      let client = new XinghuoClient({
        ssoSessionId,
        cache: cacheOptions
      })
      // 获取图片资源
      const image = await getImg(e)
      let response = await client.sendMessage(prompt, {
        e,
        chatId: conversation?.conversationId,
        image: image ? image[0] : undefined,
        system: opt.system.xh
      })
      return response
    } else if (use === 'azure') {
      let azureModel
      try {
        azureModel = await import('@azure/openai')
      } catch (error) {
        throw new Error('未安装@azure/openai包，请执行pnpm install @azure/openai安装')
      }
      let OpenAIClient = azureModel.OpenAIClient
      let AzureKeyCredential = azureModel.AzureKeyCredential
      let msg = conversation.messages
      let content = {
        role: 'user',
        content: prompt
      }
      msg.push(content)
      const client = new OpenAIClient(Config.azureUrl, new AzureKeyCredential(Config.azApiKey))
      const deploymentName = Config.azureDeploymentName
      const { choices } = await client.getChatCompletions(deploymentName, msg)
      let completion = choices[0].message
      return {
        text: completion.content,
        message: completion
      }
    } else if (use === 'qwen') {
      let completionParams = {
        parameters: {
          top_p: Config.qwenTopP || 0.5,
          top_k: Config.qwenTopK || 50,
          seed: Config.qwenSeed > 0 ? Config.qwenSeed : Math.floor(Math.random() * 114514),
          temperature: Config.qwenTemperature || 1,
          enable_search: !!Config.qwenEnableSearch,
          result_format: 'message'
        }
      }
      if (Config.qwenModel) {
        completionParams.model = Config.qwenModel
      }
      const currentDate = new Date().toISOString().split('T')[0]

      async function um (message) {
        return await upsertMessage(message, 'QWEN')
      }

      async function gm (id) {
        return await getMessageById(id, 'QWEN')
      }

      let opts = {
        apiKey: Config.qwenApiKey,
        debug: Config.debug,
        upsertMessage: um,
        getMessageById: gm,
        systemMessage: `You are ${Config.assistantLabel} ${useCast?.api || opt.system.qwen || defaultPropmtPrefix}
        Current date: ${currentDate}`,
        completionParams,
        assistantLabel: Config.assistantLabel,
        fetch: newFetch
      }

      let option = {
        timeoutMs: 600000,
        completionParams
      }
      if (conversation) {
        if (!conversation.conversationId) {
          conversation.conversationId = uuid()
        }
        option = Object.assign(option, conversation)
      }
      if (opt.enableSmart) {
        let requesterRole = await getRequesterGroupRole(e)
        let isAdmin = ['admin', 'owner'].includes(requesterRole)
        let sender = e.sender.user_id
        const {
          funcMap,
          fullFuncMap,
          promptAddition,
          systemAddition
        } = await collectTools(e)
        if (!option.completionParams) {
          option.completionParams = {}
        }
        promptAddition && (prompt += promptAddition)
        option.systemMessage = await handleSystem(e, opts.systemMessage, opt.settings)
        if (Config.enableChatSuno) {
          option.systemMessage += '如果我要求你生成音乐或写歌，你需要回复适合Suno生成音乐的信息。请使用Verse、Chorus、Bridge、Outro和End等关键字对歌词进行分段，如[Verse 1]。音乐信息需要使用markdown包裹的JSON格式回复给我，结构为```json{"option": "Suno", "tags": "style", "title": "title of the song", "lyrics": "lyrics"}```。'
        }
        systemAddition && (option.systemMessage += systemAddition)
        opts.completionParams.parameters.tools = Object.keys(funcMap)
          .map(k => funcMap[k].function)
          .map(obj => {
            return {
              type: 'function',
              function: obj
            }
          })
        let msg
        try {
          this.qwenApi = new QwenApi(opts)
          msg = await this.qwenApi.sendMessage(prompt, option)
          logger.info(msg)
          let toolCallCount = 0
          const smartTrace = []
          appendReasoningTrace(smartTrace, msg, '模型思考 1')
          while (msg.functionCall) {
            if (toolCallCount >= MAX_SMART_TOOL_CALLS) {
              logger.warn(`[chatgpt-plugin]智能模式工具调用超过${MAX_SMART_TOOL_CALLS}次，停止继续调用工具并要求模型基于已有结果回答`)
              option.parentMessageId = msg.id
              option.name = msg.functionCall.name
              disableFunctionCalling(option.completionParams)
              msg = await this.qwenApi.sendMessage('tool call limit reached. Please answer the user now based on the previous tool results. Do not call more tools.', option, 'tool')
              logger.info(msg)
              appendReasoningTrace(smartTrace, msg, `模型思考 ${toolCallCount + 2}`)
              break
            }
            toolCallCount++
            if (msg.text) {
              await e.reply(msg.text.replace('\n\n\n', '\n'))
            }
            let {
              name,
              arguments: args
            } = msg.functionCall
            args = JSON.parse(args)
            const resolvedTool = resolveToolCall(fullFuncMap, name)
            // 感觉换成targetGroupIdOrUserQQNumber这种表意比较清楚的变量名，效果会好一丢丢
            if (!args.groupId) {
              args.groupId = (e.group_id || e.sender.user_id) + ''
            }
            if (Number.isNaN(parseInt(args.groupId))) {
              args.groupId = (e.group_id || e.sender.user_id) + ''
            }
            let functionResult
            if (!resolvedTool.tool?.exec) {
              functionResult = `tool ${name} is unavailable. Available tool names: ${Object.keys(fullFuncMap).join(', ')}`
            } else if (!isManagementToolAvailable(funcMap, resolvedTool.name)) {
              functionResult = `tool ${resolvedTool.name} is unavailable in this chat scene or for the current requester permission`
            } else {
              functionResult = await resolvedTool.tool.exec.bind(this)(Object.assign({
                isAdmin,
                sender
              }, args), e)
            }
            logger.mark(`function ${name} execution result: ${functionResult}`)
            appendToolTrace(smartTrace, resolvedTool.name || name, args, functionResult)
            option.parentMessageId = msg.id
            option.name = resolvedTool.name || name
            option.toolCallId = msg.toolCalls?.[0]?.id || (resolvedTool.name || name).trim()
            logger.mark(`[chatgpt-plugin] tool result feedback: name=${resolvedTool.name || name}, toolCallId=${option.toolCallId}`)
            const finalizeAfterTool = shouldFinalizeAfterTool(resolvedTool.name || name, functionResult)
            if (finalizeAfterTool) {
              disableFunctionCalling(option.completionParams)
            }
            // 不然普通用户可能会被openai限速
            await common.sleep(300)
            msg = await this.qwenApi.sendMessage(
              finalizeAfterTool ? `${functionResult}\nThe action is complete. Reply to the user now and do not call more tools.` : functionResult,
              option,
              'tool'
            )
            logger.info(msg)
            appendReasoningTrace(smartTrace, msg, `模型思考 ${toolCallCount + 1}`)
            if (finalizeAfterTool) {
              break
            }
          }
          finalizeSmartTrace(msg, smartTrace)
        } catch (err) {
          logger.error(err)
          throw new Error(err)
        }
        return msg
      } else {
        let msg
        try {
          this.qwenApi = new QwenApi(opts)
          msg = await this.qwenApi.sendMessage(prompt, option)
        } catch (err) {
          logger.error(err)
          throw new Error(err)
        }
        return msg
      }
    } else if (use === 'gemini') {
      let client = new CustomGoogleGeminiClient({
        e,
        userId: e.sender.user_id,
        key: Config.getGeminiKey(),
        model: Config.geminiModel,
        baseUrl: Config.geminiBaseUrl,
        debug: Config.debug
      })
      let option = {
        stream: false,
        onProgress: (data) => {
          if (Config.debug) {
            logger.info(data)
          }
        },
        parentMessageId: conversation.parentMessageId,
        conversationId: conversation.conversationId,
        search: Config.geminiEnableGoogleSearch,
        codeExecution: Config.geminiEnableCodeExecution
      }
      const image = await getImg(e)
      let imageUrl = image ? image[0] : undefined
      if (imageUrl) {
        const response = await fetch(imageUrl)
        const base64Image = Buffer.from(await response.arrayBuffer())
        option.image = base64Image.toString('base64')
      }
      if (opt.enableSmart) {
        const {
          funcMap
        } = await collectTools(e)
        let tools = Object.keys(funcMap).map(k => funcMap[k].tool)
        client.addTools(tools)
      }
      let system = opt.system.gemini
      if (opt.settings.enableGroupContext && e.isGroup) {
        let chats = await getChatHistoryGroup(e, Config.groupContextLength)
        const namePlaceholder = '[name]'
        const defaultBotName = 'GeminiPro'
        const groupContextTip = Config.groupContextTip
        let botName = e.isGroup ? (e.group.pickMember(getUin(e)).card || e.group.pickMember(getUin(e)).nickname) : e.bot.nickname
        system = system.replaceAll(namePlaceholder, botName || defaultBotName) +
          ((opt.settings.enableGroupContext && e.group_id) ? groupContextTip : '')
        system += 'Attention, you are currently chatting in a qq group, then one who asks you now is' + `${e.sender.card || e.sender.nickname}(${e.sender.user_id}).`
        system += `the group name is ${e.group.name || e.group_name}, group id is ${e.group_id}.`
        system += `Your nickname is ${botName} in the group,`
        if (chats) {
          system += 'There is the conversation history in the group, you must chat according to the conversation history context"'
          system += chats
            .map(chat => {
              let sender = chat.sender || {}
              return `【${sender.card || sender.nickname}】(qq：${sender.user_id}, ${roleMap[sender.role] || 'normal user'}，${sender.area ? 'from ' + sender.area + ', ' : ''} ${sender.age} years old, 群头衔：${sender.title}, gender: ${sender.sex}, time：${formatDate(new Date(chat.time * 1000))}, messageId: ${chat.message_id}) 说：${chat.raw_message}`
            })
            .join('\n')
        }
      }
      if (Config.enableChatSuno) {
        system += 'If I ask you to generate music or write songs, you need to reply with information suitable for Suno to generate music. Please use keywords such as Verse, Chorus, Bridge, Outro, and End to segment the lyrics, such as [Verse 1], The returned message is in JSON format, with a structure of ```json{"option": "Suno", "tags": "style", "title": "title of the song", "lyrics": "lyrics"}```.'
      }
      option.system = system
      option.replyPureTextCallback = opt.settings.replyPureTextCallback || (async (msg) => {
        if (msg) {
          await e.reply(msg, true)
        }
      })
      option.toolMode = (opt.settings.forceTool || Config.geminiForceToolKeywords?.find(k => prompt?.includes(k))) ? 'ANY' : 'AUTO'
      return await client.sendMessage(prompt, option)
    } else if (use === 'chatglm4') {
      const client = new ChatGLM4Client({
        refreshToken: Config.chatglmRefreshToken
      })
      let resp = await client.sendMessage(prompt, conversation)
      if (resp.image) {
        e.reply(segment.image(resp.image), true)
      }
      return resp
    } else {
      // openai api
      let completionParams = {}
      if (Config.model) {
        completionParams.model = Config.model
      }
      const apiThinkingMode = opt.apiThinkingMode || Config.apiThinkingMode
      const apiReasoningEffort = opt.apiReasoningEffort || Config.apiReasoningEffort
      if (apiThinkingMode && apiThinkingMode !== 'default') {
        completionParams.thinking = {
          type: apiThinkingMode
        }
      }
      if (apiReasoningEffort && apiReasoningEffort !== 'default') {
        completionParams.reasoning_effort = apiReasoningEffort
      }
      const currentDate = new Date().toISOString().split('T')[0]
      let promptPrefix = `You are ${Config.assistantLabel} ${useCast?.api || opt.system.api || defaultPropmtPrefix}
        Current date: ${currentDate}`
      let maxModelTokens = getMaxModelTokens(completionParams.model)
      // let system = promptPrefix
      let system = await handleSystem(e, promptPrefix, opt.settings)
      if (Config.enableChatSuno) {
        system += 'If I ask you to generate music or write songs, you need to reply with information suitable for Suno to generate music. Please use keywords such as Verse, Chorus, Bridge, Outro, and End to segment the lyrics, such as [Verse 1], The returned song information needs to be wrapped in JSON format and sent to me in Markdown format. The message structure is ` ` JSON {"option": "Suno", "tags": "style", "title": "title of The Song", "lyrics": "lyrics"} `.'
      }
      logger.debug(system)
      let opts = {
        apiBaseUrl: Config.openAiBaseUrl,
        apiKey: Config.apiKey,
        debug: false,
        upsertMessage,
        getMessageById,
        systemMessage: system,
        completionParams,
        assistantLabel: Config.assistantLabel,
        fetch: newFetch,
        maxModelTokens,
        maxResponseTokens: Config.apiMaxToken
      }
      let openAIAccessible = (Config.proxy || !(await isCN())) // 配了代理或者服务器在国外，默认认为不需要反代
      if (opts.apiBaseUrl !== defaultOpenAIAPI && openAIAccessible && !Config.openAiForceUseReverse) {
        // 如果配了proxy(或者不在国内)，而且有反代，但是没开启强制反代,将baseurl删掉
        delete opts.apiBaseUrl
      }
      // const client = new OpenAI({
      //   apiKey: Config.apiKey,
      //   baseURL: opts.apiBaseUrl,
      //   fetch: newFetch
      // })

      this.chatGPTApi = new ChatGPTAPI(opts)
      let option = {
        timeoutMs: 600000,
        completionParams,
        stream: Config.apiStream,
        onProgress: (data) => {
          if (Config.debug) {
            logger.info(data?.text || data.functionCall || data)
          }
        }
        // systemMessage: promptPrefix
      }
      option.systemMessage = system
      if (conversation) {
        if (!conversation.conversationId) {
          conversation.conversationId = uuid()
        }
        option = Object.assign(option, conversation)
      }
      if (opt.enableSmart) {
        let requesterRole = await getRequesterGroupRole(e)
        let isAdmin = ['admin', 'owner'].includes(requesterRole)
        let sender = e.sender.user_id
        const {
          funcMap,
          fullFuncMap,
          promptAddition,
          systemAddition
        } = await collectTools(e)
        if (!option.completionParams) {
          option.completionParams = {}
        }
        promptAddition && (prompt += promptAddition)
        systemAddition && (option.systemMessage += systemAddition)
        option.completionParams.functions = Object.keys(funcMap).map(k => funcMap[k].function)
        let msg
        try {
          msg = await this.chatGPTApi.sendMessage(prompt, option)
          logger.info(msg)
          let toolCallCount = 0
          const smartTrace = []
          appendReasoningTrace(smartTrace, msg, '模型思考 1')
          while (msg.functionCall) {
            if (toolCallCount >= MAX_SMART_TOOL_CALLS) {
              logger.warn(`[chatgpt-plugin]智能模式工具调用超过${MAX_SMART_TOOL_CALLS}次，停止继续调用工具并要求模型基于已有结果回答`)
              option.parentMessageId = msg.id
              option.name = msg.functionCall.name
              option.toolCallId = msg.toolCalls?.[0]?.id
              disableFunctionCalling(option.completionParams)
              msg = await this.chatGPTApi.sendMessage('tool call limit reached. Please answer the user now based on the previous tool results. Do not call more tools.', option, 'tool')
              logger.info(msg)
              appendReasoningTrace(smartTrace, msg, `模型思考 ${toolCallCount + 2}`)
              break
            }
            toolCallCount++
            if (msg.text) {
              await e.reply(msg.text.replace('\n\n\n', '\n'))
            }
            let {
              name,
              arguments: args
            } = msg.functionCall
            args = JSON.parse(args)
            const resolvedTool = resolveToolCall(fullFuncMap, name)
            // 感觉换成targetGroupIdOrUserQQNumber这种表意比较清楚的变量名，效果会好一丢丢
            if (!args.groupId) {
              args.groupId = (e.group_id || e.sender.user_id) + ''
            }
            if (Number.isNaN(parseInt(args.groupId))) {
              args.groupId = (e.group_id || e.sender.user_id) + ''
            }
            let functionResult
            if (!resolvedTool.tool?.exec) {
              functionResult = `tool ${name} is unavailable. Available tool names: ${Object.keys(fullFuncMap).join(', ')}`
            } else if (!isManagementToolAvailable(funcMap, resolvedTool.name)) {
              functionResult = `tool ${resolvedTool.name} is unavailable in this chat scene or for the current requester permission`
            } else {
              functionResult = await resolvedTool.tool.exec.bind(this)(Object.assign({
                isAdmin,
                sender
              }, args), e)
            }
            logger.mark(`function ${name} execution result: ${functionResult}`)
            appendToolTrace(smartTrace, resolvedTool.name || name, args, functionResult)
            option.parentMessageId = msg.id
            option.name = resolvedTool.name || name
            option.toolCallId = msg.toolCalls?.[0]?.id || (resolvedTool.name || name).trim()
            logger.mark(`[chatgpt-plugin] tool result feedback: name=${resolvedTool.name || name}, toolCallId=${option.toolCallId}`)
            const finalizeAfterTool = shouldFinalizeAfterTool(resolvedTool.name || name, functionResult)
            if (finalizeAfterTool) {
              disableFunctionCalling(option.completionParams)
            }
            // 不然普通用户可能会被openai限速
            await common.sleep(300)
            msg = await this.chatGPTApi.sendMessage(
              finalizeAfterTool ? `${functionResult}\nThe action is complete. Reply to the user now and do not call more tools.` : functionResult,
              option,
              'tool'
            )
            logger.info(msg)
            appendReasoningTrace(smartTrace, msg, `模型思考 ${toolCallCount + 1}`)
            if (finalizeAfterTool) {
              break
            }
          }
          finalizeSmartTrace(msg, smartTrace)
        } catch (err) {
          if (err.message?.indexOf('context_length_exceeded') > 0) {
            logger.warn(err)
            await redis.del(`CHATGPT:CONVERSATIONS:${getConversationScope(e)}`)
            await redis.del(`CHATGPT:WRONG_EMOTION:${e.sender.user_id}`)
            await e.reply('字数超限啦，将为您自动结束本次对话。')
            return null
          } else {
            logger.error(err)
            throw new Error(err)
          }
        }
        return msg
      } else {
        let msg
        try {
          msg = await this.chatGPTApi.sendMessage(prompt, option)
        } catch (err) {
          if (err.message?.indexOf('context_length_exceeded') > 0) {
            logger.warn(err)
            await redis.del(`CHATGPT:CONVERSATIONS:${getConversationScope(e)}`)
            await redis.del(`CHATGPT:WRONG_EMOTION:${e.sender.user_id}`)
            await e.reply('字数超限啦，将为您自动结束本次对话。')
            return null
          } else {
            logger.error(err)
            throw new Error(err)
          }
        }
        return msg
      }
    }
  }
}

/**
 * 收集tools
 * @param e
 * @return {Promise<{systemAddition, funcMap: {}, promptAddition: string, fullFuncMap: {}}>}
 */
async function collectTools (e) {
  let serpTool
  switch (Config.serpSource) {
    case 'tavily': {
      serpTool = new TavilySearchTool()
      break
    }
    case 'ikechan8370': {
      serpTool = new SerpIkechan8370Tool()
      break
    }
    case 'azure': {
      if (!Config.azSerpKey) {
        logger.warn('未配置bing搜索密钥，转为使用ikechan8370搜索源')
        serpTool = new SerpIkechan8370Tool()
      } else {
        serpTool = new SerpTool()
      }
      break
    }
    default: {
      serpTool = new SerpIkechan8370Tool()
    }
  }
  let fullTools = [
    new EditCardTool(),
    // new QueryStarRailTool(),
    new WebsiteTool(),
    new JinyanTool(),
    new KickOutTool(),
    new WeatherTool(),
    new SendPictureTool(),
    new SendVideoTool(),
    new ImageCaptionTool(),
    new SearchVideoTool(),
    new SendAvatarTool(),
    new SerpImageTool(),
    new SearchMusicTool(),
    new SendMusicTool(),
    new SerpIkechan8370Tool(),
    new SerpTool(),
    serpTool,
    new SendAudioMessageTool(),
    new SendRPSTool(),
    // new ProcessPictureTool(),
    new APTool(),
    new HandleMessageMsgTool(),
    new QueryUserinfoTool(),
    // new EliMusicTool(),
    // new EliMovieTool(),
    new SendMessageToSpecificGroupOrUserTool(),
    new SendDiceTool(),
    new QueryGenshinTool(),
    new SetTitleTool(),
    new GithubAPITool()
  ]
  // todo 3.0再重构tool的插拔和管理
  let /** @type{AbstractTool[]} **/ tools = [
    new SendAvatarTool(),
    new SendDiceTool(),
    new SendMessageToSpecificGroupOrUserTool(),
    // new EditCardTool(),
    new QueryStarRailTool(),
    new QueryGenshinTool(),
    new SendMusicTool(),
    new SearchMusicTool(),
    new ProcessPictureTool(),
    new WebsiteTool(),
    // new JinyanTool(),
    // new KickOutTool(),
    new WeatherTool(),
    new SendPictureTool(),
    new SendAudioMessageTool(),
    new SendRPSTool(),
    new APTool(),
    // new HandleMessageMsgTool(),
    serpTool,
    new QueryUserinfoTool(),
    new GithubAPITool()
  ]
  let systemAddition = ''
  if (e.isGroup) {
    let botInfo = await e.bot?.pickMember?.(e.group_id, getUin(e)) || await e.bot?.getGroupMemberInfo?.(e.group_id, getUin(e))
    if (botInfo?.role && botInfo.role !== 'member') {
      const senderRole = await getRequesterGroupRole(e)
      const senderIsMaster = await isRequesterMaster(e)
      const canModerate = senderIsMaster || ['owner', 'admin'].includes(senderRole)
      const canKick = senderIsMaster || senderRole === 'owner'
      tools.push(new JinyanTool())
      if (canModerate) {
        tools.push(...[new EditCardTool(), new HandleMessageMsgTool()])
        if (botInfo?.role === 'owner') {
          tools.push(new SetTitleTool())
        }
      }
      if (canKick) {
        tools.push(new KickOutTool())
      }
      if (canModerate) {
        // 用于撤回和加精的id
        if (e.source?.seq) {
          let source = (await e.group.getChatHistory(e.source?.seq, 1)).pop()
          systemAddition += `\nthe current request is replying to messageId ${source.message_id}. Only use handleMsg for that replied message when the requester explicitly asks to manage it.\n`
        }
        systemAddition += '\nNever recall or manage the current request message itself.\n'
      }
    }
  }
  let promptAddition = ''
  let img = await getImg(e)
  if (img?.length > 0 && Config.extraUrl) {
    tools.push(new ImageCaptionTool())
    // tools.push(new ProcessPictureTool())
    promptAddition += `\nthe url of the picture(s) above: ${img.join(', ')}`
  } else {
    tools.push(new SerpImageTool())
    tools.push(...[new SearchVideoTool(),
      new SendVideoTool()])
  }
  let funcMap = {}
  let fullFuncMap = {}
  tools.forEach(tool => {
    funcMap[tool.name] = {
      exec: tool.func,
      function: tool.function(),
      tool
    }
  })
  fullTools.forEach(tool => {
    fullFuncMap[tool.name] = {
      exec: tool.func,
      function: tool.function(),
      tool
    }
  })
  return {
    funcMap,
    fullFuncMap,
    systemAddition,
    promptAddition
  }
}

export default new Core()
