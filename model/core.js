import { Config, defaultOpenAIAPI } from '../utils/config.js'
import {
  formatDate,
  generateAudio,
  getImg,
  getMasterQQ, getMaxModelTokens,
  getUin,
  getUserData,
  isCN
} from '../utils/common.js'
import { getChatHistoryGroup } from '../utils/chat.js'
import { getMessageById, upsertMessage } from '../utils/history.js'
import { v4 as uuid } from 'uuid'
import common from '../../../lib/common/common.js'
import { ChatGPTAPI } from '../utils/openai/chatgpt-api.js'
import { newFetch } from '../utils/proxy.js'
import {
  createChatErrorLog,
  createChatResponseLog,
  createToolExecutionLog
} from '../dist/runtime/safe-chat-logging.js'
import { createLegacySessionBridge } from '../dist/runtime/legacy-session-bridge.js'
import {
  createYunzaiToolRuntimeBridge,
  toolResourceFromLegacySegment
} from '../dist/runtime/tools/legacy-tool-runtime-bridge.js'
import { shouldFinalizeToolResult } from '../dist/agent/tools/tool-result.js'
import { withInvalidFormatRecovery } from '../dist/runtime/provider-request-recovery.js'

export const roleMap = {
  owner: 'group owner',
  admin: 'group administrator'
}

const defaultPropmtPrefix = ', a large language model trained by OpenAI. You answer as concisely as possible for each response (e.g. don’t be verbose). It is very important that you answer as concisely as possible, so please remember this. If you are generating a list, do not have too many items. Keep the number of items short.'
const MAX_SMART_TOOL_CALLS = 8
const MAX_TOOL_RESULT_TRACE_LENGTH = 4000
const toolRuntimeBridge = createYunzaiToolRuntimeBridge({
  config: Config,
  redis,
  getMasterIds: getMasterQQ,
  getBotId: getUin,
  getImages: getImg,
  synthesizeAudio: async (event, text, _voice, signal) => {
    if (signal.aborted) throw new DOMException('operation was aborted', 'AbortError')
    const sendable = await generateAudio(event, text)
    if (!sendable) throw new Error('audio generation failed')
    return toolResourceFromLegacySegment(sendable)
  },
  segment: () => global.segment,
  logger
})
async function clearCurrentConversation (e) {
  const bridge = createLegacySessionBridge({ redis, logger })
  await bridge.delete(e, Config.groupMerge)
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
  async sendMessage (prompt, conversation = {}, use = 'api', e, opt = {
    enableSmart: Config.smartMode,
    system: {
      api: Config.promptPrefixOverride
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
  let recoverySystem = promptPrefix
  let system = await handleSystem(e, promptPrefix, opt.settings)
  if (Config.enableChatSuno) {
    const sunoSystem = 'If I ask you to generate music or write songs, you need to reply with information suitable for Suno to generate music. Please use keywords such as Verse, Chorus, Bridge, Outro, and End to segment the lyrics, such as [Verse 1], The returned song information needs to be wrapped in JSON format and sent to me in Markdown format. The message structure is ` ` JSON {"option": "Suno", "tags": "style", "title": "title of The Song", "lyrics": "lyrics"} `.'
    system += sunoSystem
    recoverySystem += sunoSystem
  }
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
    timeoutMs: Config.defaultTimeoutMs,
    completionParams,
    stream: Config.apiStream,
    onProgress: () => {}
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
    const toolRun = await toolRuntimeBridge.begin({ event: e, prompt })
    if (!option.completionParams) {
      option.completionParams = {}
    }
    toolRun.promptAddition && (prompt += toolRun.promptAddition)
    if (toolRun.systemAddition) {
      option.systemMessage += toolRun.systemAddition
      recoverySystem += toolRun.systemAddition
    }
    option.completionParams.functions = toolRun.modelFunctions
    let msg
    let retainToolRun = false
    try {
      const droppedConversationHistory = Boolean(option.parentMessageId)
      const droppedOptionalContext = option.systemMessage !== recoverySystem
      msg = await withInvalidFormatRecovery({
        canRecover: droppedConversationHistory || droppedOptionalContext,
        onRecovery: () => logger.warn({
          event: 'chat.request.recovery',
          reasonCode: 'provider_invalid_format',
          droppedConversationHistory,
          droppedOptionalContext
        }),
        attempt: async kind => {
          if (kind === 'recovery') {
            option = {
              ...option,
              conversationId: uuid(),
              systemMessage: recoverySystem
            }
            delete option.parentMessageId
            delete option.messageId
            delete option.name
            delete option.toolCallId
          }
          return await this.chatGPTApi.sendMessage(prompt, option)
        }
      })
      if (Config.debug) logger.info(createChatResponseLog({ mode: use, response: msg }))
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
          if (Config.debug) logger.info(createChatResponseLog({ mode: use, response: msg }))
          appendReasoningTrace(smartTrace, msg, `模型思考 ${toolCallCount + 2}`)
          break
        }
        toolCallCount++
        if (msg.text) {
          await e.reply(msg.text.replace('\n\n\n', '\n'))
        }
        const {
          name,
          arguments: args
        } = msg.functionCall
        const callId = msg.toolCalls?.[0]?.id || `${toolRun.snapshotId}-${toolCallCount}`
        const {
          toolName,
          modelFeedback: functionResult,
          result: toolResult,
          finalize: finalizeAfterTool,
          approvalRequired
        } = await toolRuntimeBridge.execute({
          snapshotId: toolRun.snapshotId,
          requestedName: name,
          arguments: args,
          callId
        })
        retainToolRun ||= approvalRequired
        if (Config.debug) logger.info(createToolExecutionLog({ name, result: functionResult }))
        appendToolTrace(smartTrace, toolName, args, functionResult)
        option.parentMessageId = msg.id
        option.name = toolName
        option.toolCallId = callId
        if (toolResult && shouldFinalizeToolResult(toolResult)) {
          msg = { noMsg: true }
          break
        }
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
        if (Config.debug) logger.info(createChatResponseLog({ mode: use, response: msg }))
        appendReasoningTrace(smartTrace, msg, `模型思考 ${toolCallCount + 1}`)
        if (finalizeAfterTool) {
          if (typeof msg?.text !== 'string' || !msg.text.trim()) {
            msg = { ...(msg || {}), text: functionResult }
          }
          break
        }
      }
      finalizeSmartTrace(msg, smartTrace)
    } catch (err) {
      if (err.message?.indexOf('context_length_exceeded') > 0) {
        logger.warn(createChatErrorLog({ mode: use, error: err }))
        await clearCurrentConversation(e)
        await redis.del(`CHATGPT:WRONG_EMOTION:${e.sender.user_id}`)
        await e.reply('字数超限啦，将为您自动结束本次对话。')
        return null
      } else {
        logger.error(createChatErrorLog({ mode: use, error: err }))
        throw err
      }
    } finally {
      toolRuntimeBridge.finish(toolRun.snapshotId, { retainForApproval: retainToolRun })
    }
    return msg
  } else {
    let msg
    try {
      msg = await this.chatGPTApi.sendMessage(prompt, option)
    } catch (err) {
      if (err.message?.indexOf('context_length_exceeded') > 0) {
        logger.warn(createChatErrorLog({ mode: use, error: err }))
        await clearCurrentConversation(e)
        await redis.del(`CHATGPT:WRONG_EMOTION:${e.sender.user_id}`)
        await e.reply('字数超限啦，将为您自动结束本次对话。')
        return null
      } else {
        logger.error(createChatErrorLog({ mode: use, error: err }))
        throw err
      }
    }
    return msg
  }
  }
}

export default new Core()
