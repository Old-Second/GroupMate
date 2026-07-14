import plugin from '../../../lib/plugins/plugin.js'
import common from '../../../lib/common/common.js'
import _ from 'lodash'
import { Config } from '../utils/config.js'
import AzureTTS from '../utils/tts/microsoft-azure.js'
import VoiceVoxTTS from '../utils/tts/voicevox.js'
import {
  formatDate,
  formatDate2,
  generateAudio,
  getDefaultReplySetting,
  getImageOcrText,
  getImg,
  getMasterQQ,
  getUin,
  getUserData,
  getUserReplySetting,
  isImage,
  makeForwardMsg,
  randomString,
  renderUrl
} from '../utils/common.js'

import fetch from 'node-fetch'
import { convertSpeaker, speakers } from '../utils/tts.js'
import { convertFaces } from '../utils/face.js'
import { getProxy } from '../utils/proxy.js'
import { generateSuggestedResponse, getChatHistoryGroup } from '../utils/chat.js'
import { collectProcessors } from '../utils/postprocessors/BasicProcessor.js'
import {
  buildLegacyQuoteForwardMessages,
  buildLegacyThinkingForwardMessages,
  presentLegacyReply,
  selectLegacyPresentationMode
} from '../model/legacy/reply-presenter.js'
import { presentPictureReply } from '../dist/runtime/picture-reply.js'
import {
  shouldFallbackVitsToText,
  shouldSendTtsText
} from '../dist/runtime/tts-presentation.js'
import {
  createChatErrorLog,
  createChatRequestLog,
  createChatResponseLog
} from '../dist/runtime/safe-chat-logging.js'
import { getChatErrorPresentation } from '../dist/runtime/chat-error-presentation.js'
import { getYunzaiAgentServiceBridge } from '../dist/runtime/agent-service-bridge.js'
import { toolResourceFromLegacySegment } from '../dist/runtime/tools/yunzai-tool-runtime.js'
import {
  endAllConversations as endAllConversationSessions,
  endConversation,
  joinConversation as joinConversationSession,
  listConversations,
  originalValues
} from '../dist/runtime/conversation-manager.js'

let version = Config.version
let proxy = getProxy()

/**
 * 每个对话保留的时长。单个对话内ai是保留上下文的。超时后销毁对话，再次对话创建新的对话。
 * 单位：秒
 * @type {number}
 *
 * 这里使用动态数据获取，以便于锅巴动态更新数据
 */
// const CONVERSATION_PRESERVE_TIME = Config.conversationPreserveTime
const newFetch = (url, options = {}) => {
  const defaultOptions = Config.proxy
    ? {
        agent: proxy(Config.proxy)
      }
    : {}
  const mergedOptions = {
    ...defaultOptions,
    ...options
  }

  return fetch(url, mergedOptions)
}

const productionAgentServiceBridge = () => getYunzaiAgentServiceBridge({
  config: Config,
  redis,
  fetch: newFetch,
  getMasterIds: getMasterQQ,
  getBotId: getUin,
  getImages: getImg,
  synthesizeAudio: async (event, text, _voice, signal) => {
    if (signal.aborted) throw new DOMException('operation was aborted', 'AbortError')
    const sendable = await generateAudio(event, text)
    if (!sendable) throw new Error('audio generation failed')
    return toolResourceFromLegacySegment(sendable)
  },
  loadGroupHistory: async (event, limit) => await getChatHistoryGroup(event, limit),
  segment: () => global.segment,
  logger
})

export class chatgpt extends plugin {
  constructor (e) {
    let toggleMode = Config.toggleMode
    super({
      /** 功能名称 */
      name: 'ChatGpt 对话',
      /** 功能描述 */
      dsc: '与人工智能对话，畅聊无限可能~',
      event: 'message',
      /** 优先级，数字越小等级越高 */
      priority: 1144,
      rule: [
        {
          /** 命令正则匹配 */
          reg: '^#(图片)?chat1[sS]*',
          /** 执行方法 */
          fnc: 'chatgpt1'
        },
        {
          /** 命令正则匹配 */
          reg: toggleMode === 'at' ? '^[^#][sS]*' : '^#(图片)?chat[^gpt][sS]*',
          /** 执行方法 */
          fnc: 'chatgpt',
          log: false
        },
        {
          reg: '^#(chatgpt)?对话列表$',
          fnc: 'getAllConversations',
          permission: 'master'
        },
        {
          reg: `^#?(${originalValues.join('|')})?(结束|新开|摧毁|毁灭|完结)对话([sS]*)$`,
          fnc: 'destroyConversations'
        },
        {
          reg: `^#?(${originalValues.join('|')})?(结束|新开|摧毁|毁灭|完结)全部对话$`,
          fnc: 'endAllConversations',
          permission: 'master'
        },
        // {
        //   reg: '#chatgpt帮助',
        //   fnc: 'help'
        // },
        {
          reg: '^#chatgpt图片模式$',
          fnc: 'switch2Picture'
        },
        {
          reg: '^#chatgpt文本模式$',
          fnc: 'switch2Text'
        },
        {
          reg: '^#chatgpt语音模式$',
          fnc: 'switch2Audio'
        },
        {
          reg: '^#chatgpt语音换源',
          fnc: 'switchTTSSource'
        },
        {
          reg: '^#chatgpt设置(语音角色|角色语音|角色)',
          fnc: 'setDefaultRole'
        },
        {
          reg: '#(OpenAI|openai)(剩余)?(余额|额度)',
          fnc: 'totalAvailable',
          permission: 'master'
        },
        {
          reg: '^#(chatgpt)?加入对话',
          fnc: 'joinConversation'
        },
      ]
    })
    this.toggleMode = toggleMode
    this.reply = async (msg, quote, data) => presentLegacyReply({
      event: e,
      handlerEvent: this.e,
      message: msg,
      quote,
      data,
      markdownEnabled: Config.enableMd,
      handler: e.runtime?.handler || {},
      logger,
      schedule: setTimeout
    })
    this.agentServiceBridge = productionAgentServiceBridge()
  }

  /**
   * 获取chatgpt当前对话列表
   * @param e
   * @returns {Promise<void>}
   */
  async getConversations (e) {
    const result = await listConversations({ bridge: this.agentServiceBridge.conversations, event: e })
    await this.reply(result.message, result.quote)
  }

  /**
   * 销毁指定人的对话
   * @param e
   * @returns {Promise<void>}
   */
  async destroyConversations (e) {
    await redis.del(`CHATGPT:WRONG_EMOTION:${e.sender.user_id}`)
    const result = await endConversation({
      bridge: this.agentServiceBridge.conversations,
      event: e,
      groupMerge: Config.groupMerge,
      toggleMode: Config.toggleMode
    })
    await this.reply(result.message, result.quote)
  }

  async endAllConversations (e) {
    const result = await endAllConversationSessions({
      bridge: this.agentServiceBridge.conversations,
      event: e
    })
    await this.reply(result.message, result.quote)
  }

  async switch2Picture (e) {
    let userReplySetting = await redis.get(`CHATGPT:USER:${e.sender.user_id}`)
    if (!userReplySetting) {
      userReplySetting = getDefaultReplySetting()
    } else {
      userReplySetting = JSON.parse(userReplySetting)
    }
    userReplySetting.usePicture = true
    userReplySetting.useTTS = false
    await redis.set(`CHATGPT:USER:${e.sender.user_id}`, JSON.stringify(userReplySetting))
    await this.reply('ChatGPT回复已转换为图片模式')
  }

  async switch2Text (e) {
    let userSetting = await getUserReplySetting(this.e)
    userSetting.usePicture = false
    userSetting.useTTS = false
    await redis.set(`CHATGPT:USER:${e.sender.user_id}`, JSON.stringify(userSetting))
    await this.reply('ChatGPT回复已转换为文字模式')
  }

  async switch2Audio (e) {
    switch (Config.ttsMode) {
      case 'vits-uma-genshin-honkai':
        if (!Config.ttsSpace) {
          await this.reply('您没有配置VITS API，请前往锅巴面板进行配置')
          return
        }
        break
      case 'azure':
        if (!Config.azureTTSKey) {
          await this.reply('您没有配置Azure Key，请前往锅巴面板进行配置')
          return
        }
        break
      case 'voicevox':
        if (!Config.voicevoxSpace) {
          await this.reply('您没有配置VoiceVox API，请前往锅巴面板进行配置')
          return
        }
        break
    }
    let userSetting = await getUserReplySetting(this.e)
    userSetting.useTTS = true
    userSetting.usePicture = false
    await redis.set(`CHATGPT:USER:${e.sender.user_id}`, JSON.stringify(userSetting))
    await this.reply('ChatGPT回复已转换为语音模式')
  }

  async switchTTSSource (e) {
    let target = e.msg.replace(/^#chatgpt语音换源/, '')
    switch (target.trim()) {
      case '1': {
        Config.ttsMode = 'vits-uma-genshin-honkai'
        break
      }
      case '2': {
        Config.ttsMode = 'azure'
        break
      }
      case '3': {
        Config.ttsMode = 'voicevox'
        break
      }
      default: {
        await this.reply('请使用#chatgpt语音换源+数字进行换源。1为vits-uma-genshin-honkai，2为微软Azure，3为voicevox')
        return
      }
    }
    await this.reply('语音转换源已切换为' + Config.ttsMode)
  }

  async setDefaultRole (e) {
    if (Config.ttsMode === 'vits-uma-genshin-honkai' && !Config.ttsSpace) {
      await this.reply('您没有配置vits-uma-genshin-honkai API，请前往后台管理或锅巴面板进行配置')
      return
    }
    if (Config.ttsMode === 'azure' && !Config.azureTTSKey) {
      await this.reply('您没有配置azure 密钥，请前往后台管理或锅巴面板进行配置')
      return
    }
    if (Config.ttsMode === 'voicevox' && !Config.voicevoxSpace) {
      await this.reply('您没有配置voicevox API，请前往后台管理或锅巴面板进行配置')
      return
    }
    const regex = /^#chatgpt设置(语音角色|角色语音|角色)/
    let speaker = e.msg.replace(regex, '').trim() || '随机'
    switch (Config.ttsMode) {
      case 'vits-uma-genshin-honkai': {
        let userSetting = await getUserReplySetting(this.e)
        userSetting.ttsRole = convertSpeaker(speaker)
        if (speakers.indexOf(userSetting.ttsRole) >= 0) {
          await redis.set(`CHATGPT:USER:${e.sender.user_id}`, JSON.stringify(userSetting))
          await this.reply(`当前语音模式为${Config.ttsMode},您的默认语音角色已被设置为 "${userSetting.ttsRole}" `)
        } else if (speaker === '随机') {
          userSetting.ttsRole = '随机'
          await redis.set(`CHATGPT:USER:${e.sender.user_id}`, JSON.stringify(userSetting))
          await this.reply(`当前语音模式为${Config.ttsMode},您的默认语音角色已被设置为 "随机" `)
        } else {
          await this.reply(`抱歉，"${userSetting.ttsRole}"我还不认识呢`)
        }
        break
      }
      case 'azure': {
        let userSetting = await getUserReplySetting(this.e)
        let chosen = AzureTTS.supportConfigurations.filter(s => s.name === speaker)
        if (speaker === '随机') {
          userSetting.ttsRoleAzure = '随机'
          await redis.set(`CHATGPT:USER:${e.sender.user_id}`, JSON.stringify(userSetting))
          await this.reply(`当前语音模式为${Config.ttsMode},您的默认语音角色已被设置为 "随机" `)
        } else if (chosen.length === 0) {
          await this.reply(`抱歉，没有"${speaker}"这个角色，目前azure模式下支持的角色有${AzureTTS.supportConfigurations.map(item => item.name).join('、')}`)
        } else {
          userSetting.ttsRoleAzure = chosen[0].code
          await redis.set(`CHATGPT:USER:${e.sender.user_id}`, JSON.stringify(userSetting))
          // Config.azureTTSSpeaker = chosen[0].code
          const supportEmotion = AzureTTS.supportConfigurations.find(config => config.name === speaker)?.emotion
          await this.reply(`当前语音模式为${Config.ttsMode},您的默认语音角色已被设置为 ${speaker}-${chosen[0].gender}-${chosen[0].languageDetail} ${supportEmotion && Config.azureTTSEmotion ? '，此角色支持多情绪配置，建议重新使用设定并结束对话以获得最佳体验！' : ''}`)
        }
        break
      }
      case 'voicevox': {
        let regex = /^(.*?)-(.*)$/
        let match = regex.exec(speaker)
        let style = null
        if (match) {
          speaker = match[1]
          style = match[2]
        }
        let userSetting = await getUserReplySetting(e)
        if (speaker === '随机') {
          userSetting.ttsRoleVoiceVox = '随机'
          await redis.set(`CHATGPT:USER:${e.sender.user_id}`, JSON.stringify(userSetting))
          await this.reply(`当前语音模式为${Config.ttsMode},您的默认语音角色已被设置为 "随机" `)
          break
        }
        let chosen = VoiceVoxTTS.supportConfigurations.filter(s => s.name === speaker)
        if (chosen.length === 0) {
          await this.reply(`抱歉，没有"${speaker}"这个角色，目前voicevox模式下支持的角色有${VoiceVoxTTS.supportConfigurations.map(item => item.name).join('、')}`)
          break
        }
        if (style && !chosen[0].styles.find(item => item.name === style)) {
          await this.reply(`抱歉，"${speaker}"这个角色没有"${style}"这个风格，目前支持的风格有${chosen[0].styles.map(item => item.name).join('、')}`)
          break
        }
        userSetting.ttsRoleVoiceVox = chosen[0].name + (style ? `-${style}` : '')
        await redis.set(`CHATGPT:USER:${e.sender.user_id}`, JSON.stringify(userSetting))
        await this.reply(`当前语音模式为${Config.ttsMode},您的默认语音角色已被设置为 "${userSetting.ttsRoleVoiceVox}" `)
        break
      }
    }
  }

  /**
   * #chatgpt
   */
  async chatgpt (e) {
    let msg = e.msg
    let prompt
    let forcePictureMode = false
    if (this.toggleMode === 'at') {
      if (!msg || e.msg?.startsWith('#')) {
        return false
      }
      if ((e.isGroup || e.group_id) && !(e.atme || e.atBot || (e.at === e.self_id))) {
        return false
      }
      if (e.user_id == getUin(e)) return false
      prompt = msg.trim()
      try {
        if (e.isGroup) {
          let mm = this.e.bot.gml
          let me = mm.get(getUin(e)) || {}
          let card = me.card
          let nickname = me.nickname
          if (nickname && card) {
            if (nickname.startsWith(card)) {
              // 例如nickname是"滚筒洗衣机"，card是"滚筒"
              prompt = prompt.replace(`@${nickname}`, '').trim()
            } else if (card.startsWith(nickname)) {
              // 例如nickname是"十二"，card是"十二｜本月已发送1000条消息"
              prompt = prompt.replace(`@${card}`, '').trim()
              // 如果是好友，显示的还是昵称
              prompt = prompt.replace(`@${nickname}`, '').trim()
            } else {
              // 互不包含，分别替换
              if (nickname) {
                prompt = prompt.replace(`@${nickname}`, '').trim()
              }
              if (card) {
                prompt = prompt.replace(`@${card}`, '').trim()
              }
            }
          } else if (nickname) {
            prompt = prompt.replace(`@${nickname}`, '').trim()
          } else if (card) {
            prompt = prompt.replace(`@${card}`, '').trim()
          }
        }
      } catch (err) {
        logger.warn(createChatErrorLog({ error: err }))
      }
    } else {
      let ats = e.message.filter(m => m.type === 'at')
      if (!(e.atme || e.atBot) && ats.length > 0) {
        if (Config.debug) {
          logger.mark('艾特别人了，没艾特我，忽略#chat')
        }
        return false
      }
      if (e.msg.trimStart().startsWith('#图片chat')) {
        forcePictureMode = true
      }
      prompt = _.replace(e.msg.trimStart(), /#(图片)?chat/, '').trim()
      if (prompt.length === 0) {
        return false
      }
    }
    let groupId = e.isGroup ? e.group.group_id : ''
    if (await redis.get('CHATGPT:SHUT_UP:ALL') || await redis.get(`CHATGPT:SHUT_UP:${groupId}`)) {
      logger.info('chatgpt闭嘴中，不予理会')
      return false
    }
    // 自动化插件本月已发送xx条消息更新太快，由于延迟和缓存问题导致不同客户端不一样，at文本和获取的card不一致。因此单独处理一下
    prompt = prompt.replace(/^｜本月已发送\d+条消息/, '')
    await this.abstractChat(e, prompt, 'api', forcePictureMode)
  }

  async abstractChat (e, prompt, use, forcePictureMode = false) {
    // 关闭私聊通道后不回复
    if (!e.isMaster && e.isPrivate && !Config.enablePrivateChat) {
      return false
    }
    // 黑白名单过滤对话
    let [whitelist = [], blacklist = []] = [Config.whitelist, Config.blacklist]
    let chatPermission = false // 对话许可
    if (typeof whitelist === 'string') {
      whitelist = [whitelist]
    }
    if (typeof blacklist === 'string') {
      blacklist = [blacklist]
    }
    if (whitelist.join('').length > 0) {
      for (const item of whitelist) {
        if (item.length > 11) {
          const [group, qq] = item.split('^')
          if (e.isGroup && group === e.group_id.toString() && qq === e.sender.user_id.toString()) {
            chatPermission = true
            break
          }
        } else if (item.startsWith('^') && item.slice(1) === e.sender.user_id.toString()) {
          chatPermission = true
          break
        } else if (e.isGroup && !item.startsWith('^') && item === e.group_id.toString()) {
          chatPermission = true
          break
        }
      }
    }
    // 当前用户有对话许可则不再判断黑名单
    if (!chatPermission) {
      if (blacklist.join('').length > 0) {
        for (const item of blacklist) {
          if (e.isGroup && !item.startsWith('^') && item === e.group_id.toString()) return false
          if (item.startsWith('^') && item.slice(1) === e.sender.user_id.toString()) return false
          if (item.length > 11) {
            const [group, qq] = item.split('^')
            if (e.isGroup && group === e.group_id.toString() && qq === e.sender.user_id.toString()) return false
          }
        }
      }
    }
    e.groupmateCurrentRequestText = prompt
    let userSetting = await getUserReplySetting(this.e)
    let useTTS = !!userSetting.useTTS
    const isImg = await getImg(e)
    if (Config.imgOcr && !!isImg) {
      let imgOcrText = await getImageOcrText(e)
      if (imgOcrText) {
        prompt = prompt + '"'
        for (let imgOcrTextKey in imgOcrText) {
          prompt += imgOcrText[imgOcrTextKey]
        }
        prompt = prompt + ' "'
      }
    }
    // 检索是否有屏蔽词
    const promtBlockWord = Config.promptBlockWords.find(word => prompt.toLowerCase().includes(word.toLowerCase()))
    if (promtBlockWord) {
      await this.reply('主人不让我回答你这种问题，真是抱歉了呢', true)
      return false
    }
    let confirm = await redis.get('CHATGPT:CONFIRM')
    let confirmOn = (!confirm || confirm === 'on') // confirm默认开启
    if (confirmOn) {
      await this.reply('我正在思考如何回复你，请稍等', true, { recallMsg: 8 })
    }
    const emotionFlag = await redis.get(`CHATGPT:WRONG_EMOTION:${e.sender.user_id}`)
    let userReplySetting = await getUserReplySetting(this.e)
    // 图片模式就不管了，降低抱歉概率
    if (Config.ttsMode === 'azure' && Config.enhanceAzureTTSEmotion && userReplySetting.useTTS === true && await AzureTTS.getEmotionPrompt(e)) {
      switch (emotionFlag) {
        case '1':
          prompt += '(上一次回复没有添加情绪，请确保接下来的对话正确使用情绪和情绪格式，回复时忽略此内容。)'
          break
        case '2':
          prompt += '(不要使用给出情绪范围的词和错误的情绪格式，请确保接下来的对话正确选择情绪，回复时忽略此内容。)'
          break
        case '3':
          prompt += '(不要给出多个情绪[]项，请确保接下来的对话给且只给出一个正确情绪项，回复时忽略此内容。)'
          break
      }
    }
    if (Config.debug) {
      logger.info(createChatRequestLog({ mode: use, stream: Config.apiStream, prompt }))
    }
    let handler = this.e.runtime?.handler || {
      has: (arg1) => false
    }
    try {
      const userData = await getUserData(e.user_id)
      const currentDate = formatDate2(new Date())
      const systemInstruction = `You are ${Config.assistantLabel}. ${userData.cast?.api || Config.promptPrefixOverride} Current date: ${currentDate}.`
      const agentReply = await this.agentServiceBridge.handle(e, prompt, {
        systemInstructions: [systemInstruction],
        enableGroupContext: Config.enableGroupContext,
        thinkingMode: Config.apiThinkingMode,
        reasoningEffort: Config.apiReasoningEffort,
        progress: async text => await this.reply(text, e.isGroup, { recallMsg: 0 }),
        sessionTtlSeconds: Config.conversationPreserveTime > 0
          ? Config.conversationPreserveTime
          : undefined
      })
      if (agentReply.kind === 'paused') {
        return false
      }
      if (agentReply.kind === 'failed') {
        logger.error(createChatErrorLog({
          mode: use,
          error: agentReply.error,
          category: agentReply.error.code
        }))
        await this.reply(agentReply.error.userMessage, true, { recallMsg: 0 })
        return false
      }
      if (agentReply.kind === 'cancelled') {
        await this.reply('任务已取消。', true, { recallMsg: 0 })
        return false
      }
      if (agentReply.text === null && agentReply.visibleOutput) return false
      if (agentReply.text === null) return false
      let chatMessage = {
        text: agentReply.text,
        conversation: {
          prompt,
          response: agentReply.text
        }
      }
      if (Config.debug) {
        logger.info(createChatResponseLog({ mode: use, response: chatMessage }))
      }
      let response = chatMessage?.text?.replace('\n\n\n', '\n')
      let postProcessors = await collectProcessors('post')
      let thinking = chatMessage.thinking_text
      let thinkingSegments = chatMessage.thinking_segments
      for (let processor of postProcessors) {
        let output = await processor.processInner({
          text: response, thinking_text: thinking
        })
        response = output.text
        thinking = output.thinking_text
        if (output.thinking_text !== chatMessage.thinking_text) {
          thinkingSegments = undefined
        }
      }
      if (handler.has('chatgpt.response.post')) {
        logger.debug('调用后处理器: chatgpt.response.post')
        handler.call('chatgpt.response.post', this.e, {
          content: response,
          thinking,
          use,
          prompt
        }, true).catch(err => {
          logger.error('后处理器出错', err)
        })
      }
      let mood = 'blandness'
      if (!response) {
        return false
      }
      let emotion, emotionDegree
      if (Config.ttsMode === 'azure' && await AzureTTS.getEmotionPrompt(e)) {
        let ttsRoleAzure = userReplySetting.ttsRoleAzure
        const emotionReg = /\[\s*['`’‘]?(\w+)[`’‘']?\s*[,，、]\s*([\d.]+)\s*\]/
        const emotionTimes = response.match(/\[\s*['`’‘]?(\w+)[`’‘']?\s*[,，、]\s*([\d.]+)\s*\]/g)
        const emotionMatch = response.match(emotionReg)
        if (emotionMatch) {
          const [startIndex, endIndex] = [
            emotionMatch.index,
            emotionMatch.index + emotionMatch[0].length - 1
          ]
          const ttsArr =
            response.length / 2 < endIndex
              ? [response.substring(startIndex), response.substring(0, startIndex)]
              : [
                  response.substring(0, endIndex + 1),
                  response.substring(endIndex + 1)
                ]
          const match = ttsArr[0].match(emotionReg)
          response = ttsArr[1].replace(/\n/, '').trim()
          if (match) {
            [emotion, emotionDegree] = [match[1], match[2]]
            const configuration = AzureTTS.supportConfigurations.find(
              (config) => config.code === ttsRoleAzure
            )
            const supportedEmotions =
              configuration.emotion && Object.keys(configuration.emotion)
            if (supportedEmotions && supportedEmotions.includes(emotion)) {
              logger.warn(`角色 ${ttsRoleAzure} 支持 ${emotion} 情绪.`)
              await redis.set(`CHATGPT:WRONG_EMOTION:${e.sender.user_id}`, '0')
            } else {
              logger.warn(`角色 ${ttsRoleAzure} 不支持 ${emotion} 情绪.`)
              await redis.set(`CHATGPT:WRONG_EMOTION:${e.sender.user_id}`, '2')
            }
            logger.info(`情绪: ${emotion}, 程度: ${emotionDegree}`)
            if (emotionTimes.length > 1) {
              logger.warn('回复包含多个情绪项')
              // 处理包含多个情绪项的情况，后续可以考虑实现单次回复多情绪的配置
              response = response.replace(/\[\s*['`’‘]?(\w+)[`’‘']?\s*[,，、]\s*([\d.]+)\s*\]/g, '').trim()
              await redis.set(`CHATGPT:WRONG_EMOTION:${e.sender.user_id}`, '3')
            }
          } else {
            // 使用了正则匹配外的奇奇怪怪的符号
            logger.warn('情绪格式错误')
            await redis.set(`CHATGPT:WRONG_EMOTION:${e.sender.user_id}`, '2')
          }
        } else {
          logger.warn('回复不包含情绪')
          await redis.set(`CHATGPT:WRONG_EMOTION:${e.sender.user_id}`, '1')
        }
      }
      mood = ''
      // 检索是否有屏蔽词
      const blockWord = Config.blockWords.find(word => response.toLowerCase().includes(word.toLowerCase()))
      if (blockWord) {
        await this.reply('返回内容存在敏感词，我不想回答你', true)
        return false
      }
      // 处理中断的代码区域
      const codeBlockCount = (response.match(/```/g) || []).length
      const shouldAddClosingBlock = codeBlockCount % 2 === 1 && !response.endsWith('```')
      if (shouldAddClosingBlock) {
        response += '\n```'
      }
      if (codeBlockCount && !shouldAddClosingBlock) {
        response = response.replace(/```$/, '\n```')
      }
      // 处理引用
      let quotemessage = []
      if (chatMessage?.quote) {
        chatMessage.quote.forEach(function (item, index) {
          if (item.text && item.text.trim() !== '') {
            quotemessage.push(item)
          }
        })
      }
      // 处理内容和引用中的图片
      const regex = /\b((?:https?|ftp|file):\/\/[-a-zA-Z0-9+&@#/%?=~_|!:,.;]*[-a-zA-Z0-9+&@#/%=~_|])/g
      let responseUrls = response.match(regex)
      let imgUrls = []
      if (responseUrls) {
        let images = await Promise.all(responseUrls.map(link => isImage(link)))
        imgUrls = responseUrls.filter((link, index) => images[index])
      }
      for (let quote of quotemessage) {
        if (quote.imageLink) imgUrls.push(quote.imageLink)
      }
      const presentationMode = selectLegacyPresentationMode({
        useTTS,
        forcePictureMode,
        userPictureMode: userSetting.usePicture,
        autoPicture: Config.autoUsePicture,
        responseLength: response.length,
        autoPictureThreshold: Config.autoUsePictureThreshold
      })
      const sendTextReply = async () => {
        let responseText = await convertFaces(response, Config.enableRobotAt, e)
        if (handler.has('chatgpt.markdown.convert')) {
          responseText = await handler.call('chatgpt.markdown.convert', this.e, {
            content: responseText,
            use,
            prompt
          })
        }
        if (quotemessage.length > 0) {
          await this.reply(await makeForwardMsg(this.e, buildLegacyQuoteForwardMessages(quotemessage)))
        }
        if (chatMessage?.conversation && Config.enableSuggestedResponses && !chatMessage.suggestedResponses && Config.apiKey) {
          try {
            chatMessage.suggestedResponses = await generateSuggestedResponse(chatMessage.conversation)
          } catch (err) {
            logger.debug('生成建议回复失败', err)
          }
        }
        await this.reply(responseText, e.isGroup, {
          btnData: {
            use,
            suggested: chatMessage.suggestedResponses
          }
        })
        if (thinking && Config.forwardReasoning) {
          const thinkingForward = await common.makeForwardMsg(e, buildLegacyThinkingForwardMessages(thinking, thinkingSegments), '思考过程')
          await this.reply(thinkingForward)
        }
        if (Config.enableSuggestedResponses && chatMessage.suggestedResponses) {
          await this.reply(`建议的回复：\n${chatMessage.suggestedResponses}`)
        }
      }
      if (presentationMode === 'tts') {
        // 缓存数据
        this.cacheContent(e, use, response, prompt, quotemessage, mood, chatMessage.suggestedResponses, imgUrls)
        // 处理tts输入文本
        let ttsResponse, ttsRegex
        const regex = /^\/(.*)\/([gimuy]*)$/
        const match = Config.ttsRegex.match(regex)
        if (match) {
          const pattern = match[1]
          const flags = match[2]
          ttsRegex = new RegExp(pattern, flags) // 返回新的正则表达式对象
        } else {
          ttsRegex = ''
        }
        ttsResponse = response.replace(ttsRegex, '')
        // 处理azure语音会读出emoji的问题
        try {
          let emojiStrip
          emojiStrip = (await import('emoji-strip')).default
          ttsResponse = emojiStrip(ttsResponse)
        } catch (error) {
          await this.reply('依赖emoji-strip未安装，请执行pnpm install emoji-strip安装依赖', true)
        }
        // 处理多行回复有时候只会读第一行和azure语音会读出一些标点符号的问题
        ttsResponse = ttsResponse.replace(/[-:_；*;\n]/g, '，')
        const ttsTextFallback = shouldFallbackVitsToText({
          ttsMode: Config.ttsMode,
          textCharacters: ttsResponse.length,
          threshold: Config.ttsAutoFallbackThreshold
        })
        const sendTtsText = shouldSendTtsText({
          alsoSendText: Config.alsoSendText,
          textCharacters: ttsResponse.length,
          threshold: Config.ttsAutoFallbackThreshold
        })
        // 先把文字回复发出去，避免过久等待合成语音
        if (sendTtsText) {
          if (ttsTextFallback) {
            await this.reply('回复的内容过长，已转为文本模式')
          }
          let responseText = await convertFaces(response, Config.enableRobotAt, e)
          if (handler.has('chatgpt.markdown.convert')) {
            responseText = await handler.call('chatgpt.markdown.convert', this.e, {
              content: responseText,
              use,
              prompt
            })
          }
          await this.reply(responseText, e.isGroup)
          if (quotemessage.length > 0) {
            this.reply(await makeForwardMsg(this.e, buildLegacyQuoteForwardMessages(quotemessage)))
          }
          if (Config.enableSuggestedResponses && chatMessage.suggestedResponses) {
            this.reply(`建议的回复：\n${chatMessage.suggestedResponses}`)
          }
        }
        if (!ttsTextFallback) {
          const sendable = await generateAudio(this.e, ttsResponse, emotion, emotionDegree)
          if (sendable) {
            await this.reply(sendable)
          } else {
            await this.reply('合成语音发生错误~')
          }
        }
      } else if (presentationMode === 'picture') {
        const pictureReplyResult = await presentPictureReply({
          renderPicture: async () => await this.renderImage(e, use, response, prompt, quotemessage, mood, chatMessage.suggestedResponses, imgUrls),
          sendTextFallback: sendTextReply,
          reportFailure: (error) => logger.error(createChatErrorLog({ mode: 'picture', error }))
        })
        if (pictureReplyResult === 'picture' && Config.enableSuggestedResponses && chatMessage.suggestedResponses) {
          this.reply(`建议的回复：\n${chatMessage.suggestedResponses}`)
        }
      } else {
        this.cacheContent(e, use, response, prompt, quotemessage, mood, chatMessage.suggestedResponses, imgUrls)
        await sendTextReply()
      }
    } catch (err) {
      const presentation = getChatErrorPresentation(err)
      logger.error(createChatErrorLog({
        mode: use,
        error: err,
        category: presentation.code
      }))
      await this.reply(presentation.message, true, { recallMsg: 0 })
    }
  }

  async chatgpt1 (e) {
    return await this.otherMode(e, 'api', /#(图片)?chat1/)
  }

  async cacheContent (e, use, content, prompt, quote = [], mood = '', suggest = '', imgUrls = []) {
    if (!Config.enableToolbox) {
      return
    }
    let cacheData = {
      file: '',
      status: ''
    }
    cacheData.file = randomString()
    const cacheresOption = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        content: {
          content: Buffer.from(content).toString('base64'),
          prompt: Buffer.from(prompt).toString('base64'),
          senderName: e.sender.nickname,
          style: Config.toneStyle,
          mood,
          quote,
          group: e.isGroup ? e.group.name : '',
          suggest: suggest ? suggest.split('\n').filter(Boolean) : [],
          images: imgUrls
        },
        model: use,
        bing: false,
        chatViewBotName: Config.chatViewBotName || '',
        entry: cacheData.file,
        userImg: `https://q1.qlogo.cn/g?b=qq&s=0&nk=${e.sender.user_id}`,
        botImg: `https://q1.qlogo.cn/g?b=qq&s=0&nk=${getUin(e)}`,
        cacheHost: Config.serverHost,
        qq: e.sender.user_id
      })
    }
    const cacheres = await fetch(Config.viewHost ? `${Config.viewHost}/` : `http://127.0.0.1:${Config.serverPort || 3321}/` + 'cache', cacheresOption)
    if (cacheres.ok) {
      cacheData = Object.assign({}, cacheData, await cacheres.json())
    } else {
      cacheData.error = '渲染服务器出错！'
    }
    cacheData.status = cacheres.status
    return cacheData
  }

  async renderImage (e, use, content, prompt, quote = [], mood = '', suggest = '', imgUrls = []) {
    const cacheData = await this.cacheContent(e, use, content, prompt, quote, mood, suggest, imgUrls)
    if (!cacheData || cacheData.error || cacheData.status != 200) return false

    const image = await renderUrl(e, (Config.viewHost ? `${Config.viewHost}/` : `http://127.0.0.1:${Config.serverPort || 3321}/`) + `page/${cacheData.file}?qr=${Config.showQRCode ? 'true' : 'false'}`, {
      retType: 'base64',
      Viewport: {
        width: parseInt(Config.chatViewWidth),
        height: parseInt(parseInt(Config.chatViewWidth) * 0.56)
      },
      func: (parseFloat(Config.live2d) && !Config.viewHost) ? 'window.Live2d == true' : '',
      deviceScaleFactor: parseFloat(Config.cloudDPR)
    })
    if (!image) return false

    await this.reply(image, e.isGroup && Config.quoteReply)
    return true
  }

  async getAllConversations (e) {
    return await this.getConversations(e)
  }

  async joinConversation (e) {
    const result = await joinConversationSession({
      bridge: this.agentServiceBridge.conversations,
      event: e,
      groupMerge: Config.groupMerge,
      toggleMode: Config.toggleMode,
      ttlSeconds: Config.conversationPreserveTime > 0
        ? Config.conversationPreserveTime
        : undefined
    })
    await this.reply(result.message, result.quote)
    return result.success
  }

  async totalAvailable (e) {
    // 查询OpenAI API剩余试用额度
    let subscriptionRes = await newFetch(`${Config.openAiBaseUrl}/dashboard/billing/subscription`, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + Config.apiKey
      }
    })

    function getDates () {
      const today = new Date()
      const tomorrow = new Date(today)
      tomorrow.setDate(tomorrow.getDate() + 1)

      const beforeTomorrow = new Date(tomorrow)
      beforeTomorrow.setDate(beforeTomorrow.getDate() - 100)

      const tomorrowFormatted = formatDate2(tomorrow)
      const beforeTomorrowFormatted = formatDate2(beforeTomorrow)

      return {
        end: tomorrowFormatted,
        start: beforeTomorrowFormatted
      }
    }

    let subscription = await subscriptionRes.json()
    let {
      hard_limit_usd: hardLimit,
      access_until: expiresAt
    } = subscription
    const {
      end,
      start
    } = getDates()
    let usageRes = await newFetch(`${Config.openAiBaseUrl}/dashboard/billing/usage?start_date=${start}&end_date=${end}`, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + Config.apiKey
      }
    })
    let usage = await usageRes.json()
    const { total_usage: totalUsage } = usage
    expiresAt = formatDate(new Date(expiresAt * 1000))
    let left = hardLimit - totalUsage / 100
    this.reply('总额度：$' + hardLimit + '\n已经使用额度：$' + totalUsage / 100 + '\n当前剩余额度：$' + left + '\n到期日期(UTC)：' + expiresAt)
  }

  /**
   * 其他模式
   * @param e
   * @param mode
   * @param {string|RegExp} pattern
   * @returns {Promise<boolean>}
   */
  async otherMode (e, mode, pattern = `#${mode}`) {
    let ats = e.message.filter(m => m.type === 'at')
    if (!(e.atme || e.atBot) && ats.length > 0) {
      if (Config.debug) {
        logger.mark('艾特别人了，没艾特我，忽略' + pattern)
      }
      return false
    }
    let prompt = _.replace(e.msg.trimStart(), pattern, '').trim()
    if (prompt.length === 0) {
      return false
    }
    let forcePictureMode = e.msg.trimStart().startsWith('#图片')
    await this.abstractChat(e, prompt, mode, forcePictureMode)
    return true
  }
}
