import { Config } from '../utils/config.js'
import { convertFaces } from '../utils/face.js'
import { customSplitRegex, filterResponseChunk } from '../utils/text.js'
import { generateAudio, getImg, getMasterQQ, getUin } from '../utils/common.js'
import { getChatHistoryGroup } from '../utils/chat.js'
import { newFetch } from '../utils/proxy.js'
import { getYunzaiAgentServiceBridge } from '../dist/runtime/agent-service-bridge.js'
import { decideBymTrigger } from '../dist/runtime/bym-trigger.js'
import { toolResourceFromLegacySegment } from '../dist/runtime/tools/yunzai-tool-runtime.js'

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

async function replyWithoutRecallingUserMessage (e, msg, quote, data = {}) {
  const recallMsg = Number(data?.recallMsg) || 0
  const safeData = {
    ...data,
    recallMsg: 0
  }
  const res = await e.reply(msg, quote, safeData)
  if (recallMsg > 0 && res?.message_id) {
    setTimeout(() => {
      if (e.group?.recallMsg) {
        e.group.recallMsg(res.message_id).catch(err => logger.warn('撤回机器人消息失败', err))
      } else if (e.friend?.recallMsg) {
        e.friend.recallMsg(res.message_id).catch(err => logger.warn('撤回机器人消息失败', err))
      }
    }, recallMsg * 1000)
  }
  return res
}

export class bym extends plugin {
  constructor () {
    super({
      name: 'ChatGPT-Plugin 伪人bym',
      dsc: 'bym',
      /** https://oicqjs.github.io/oicq/#events */
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^[^#][sS]*',
          fnc: 'bym',
          priority: '-1000000',
          log: false
        }
      ]
    })
    this.agentServiceBridge = productionAgentServiceBridge()
  }

  /** 复读 */
  async bym (e) {
    if (!Config.enableBYM) {
      return false
    }

    // 伪人禁用群
    if (Config.bymDisableGroup?.includes(e.group_id?.toString())) {
      return false
    }

    const trigger = decideBymTrigger({
      message: e.msg,
      assistantLabel: Config.assistantLabel,
      hasLeadingAlias: e.hasAlias === true,
      recognizeLeadingAlias: Config.bymRecognizeLeadingAlias
    })
    if (trigger.prompt === null) return false
    const prompt = trigger.prompt

    let sender = e.sender.user_id
    let prop = Math.floor(Math.random() * 100)
    if (trigger.explicitlyAddressed) {
      prop = -1
    }
    // 去掉吧 频率有点逆天
    // if (e.msg?.endsWith('？')) {
    //   prop = prop / 10
    // }

    let fuck = false
    let candidate = Config.bymPreset
    if (Config.bymFuckList?.find(i => prompt.includes(i))) {
      // 检查是否在黑名单中
      if (!Config.bymFuckBlacklist?.includes(sender.toString())) {
        fuck = true
        candidate = candidate + Config.bymFuckPrompt
      }
    }
    if (prop < Config.bymRate) {
      logger.info('random chat hit')
      const recallAfterMs = fuck && Config.bymFuckRecall
        ? Math.min(Math.max(Math.trunc(Number(Config.bymFuckRecallTime) || 100), 1), 3600) * 1000
        : null
      let system = `你的名字是“${Config.assistantLabel}”，你是QQ群里的一名普通群友。请结合用户发言和聊天记录作出回应，表现得随性自然，最好参与讨论、融入其中。不要过分插科打诨，不知道说什么可以复读群友的话。要求你做搜索、发图、发视频和音乐等操作时使用工具，不可以直接发[图片]蒙混过关。优先使用中文；如果此时不需要自己说话，只回复<EMPTY>。` +
        candidate +
        `\n你的回复应该尽可能简练，像人类一样随意，不要附加任何奇怪的东西，如聊天记录的格式（比如${Config.assistantLabel}：），禁止重复聊天记录。`

      const rsp = await this.agentServiceBridge.handleEphemeral(e, trigger.prompt, {
        presentationIntent: {
          schemaVersion: 1,
          kind: 'proactive',
          recallAfterMs
        },
        systemInstructions: [system],
        enableGroupContext: true,
        thinkingMode: Config.bymThinkingMode,
        reasoningEffort: Config.bymReasoningEffort
      })
      if (rsp.kind !== 'completed' || rsp.text === null || rsp.visibleOutput) {
        if (rsp.kind === 'failed') {
          logger.warn(`主动群聊运行失败：${rsp.error.code}`)
        }
        return false
      }
      let text = rsp.text.trim()
      if (text === '<EMPTY>') return false
      let texts = customSplitRegex(text, /(?<!\?)[。？\n](?!\?)/, 3)
      // let texts = text.split(/(?<!\?)[。？\n](?!\?)/, 3)
      for (let t of texts) {
        if (!t) {
          continue
        }
        t = t.trim()
        if (text[text.indexOf(t) + t.length] === '？') {
          t += '？'
        }
        let finalMsg = await convertFaces(t, true, e)
        logger.info(JSON.stringify(finalMsg))
        finalMsg = finalMsg.map(filterResponseChunk).filter(i => !!i)
        if (finalMsg && finalMsg.length > 0) {
          if (Math.floor(Math.random() * 100) < 10) {
            await replyWithoutRecallingUserMessage(e, finalMsg, true, {
              recallMsg: recallAfterMs / 1000
            })
          } else {
            await replyWithoutRecallingUserMessage(e, finalMsg, false, {
              recallMsg: recallAfterMs / 1000
            })
          }
          await new Promise((resolve, reject) => {
            setTimeout(() => {
              resolve()
            }, Math.min(t.length * 200, 3000))
          })
        }
      }
    }
    return false
  }
}
