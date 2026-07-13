import plugin from '../../../lib/plugins/plugin.js'
import { Config, supportedConfigKeys } from '../utils/config.js'
import {
  formatDuration,
  getAzureRoleList,
  getPublicIP,
  getUserReplySetting,
  getVitsRoleList,
  getVoicevoxRoleList,
  makeForwardMsg,
  parseDuration,
  renderUrl,
  randomString
} from '../utils/common.js'
import { convertSpeaker, speakers as vitsRoleList } from '../utils/tts.js'
import md5 from 'md5'
import path from 'path'
import fs from 'fs'
import loader from '../../../lib/plugins/loader.js'
import VoiceVoxTTS, { supportConfigurations as voxRoleList } from '../utils/tts/voicevox.js'
import { supportConfigurations as azureRoleList } from '../utils/tts/microsoft-azure.js'
import fetch from 'node-fetch'
import { runServer, stopServer } from '../server/index.js'
import { resolvePluginPath } from '../dist/runtime/plugin-context.js'
import { selectImportableConfig } from '../dist/runtime/config-persistence.js'
import { migrateLegacyCrossChannelPolicies } from '../dist/runtime/tools/cross-channel-policy.js'
import {
  providerModeMigrationEvent,
  resolveProviderMode,
  resolveProviderModeForRuntime
} from '../dist/runtime/provider-mode-policy.js'

export class ChatgptManagement extends plugin {
  constructor (e) {
    super({
      name: 'ChatGPT-Plugin 管理',
      dsc: '插件的管理项配置，让你轻松掌控各个功能的开闭和管理。包含各种实用的配置选项，让你的聊天更加便捷和高效！',
      event: 'message',
      priority: 500,
      rule: [
        {
          reg: '^#chatgpt开启(问题)?(回复)?确认',
          fnc: 'turnOnConfirm',
          permission: 'master'
        },
        {
          reg: '^#chatgpt关闭(问题)?(回复)?确认',
          fnc: 'turnOffConfirm',
          permission: 'master'
        },
        {
          reg: '^#chatgpt切换API$',
          fnc: 'useOpenAIAPIBasedSolution',
          permission: 'master'
        },
        {
          reg: '^#chatgpt模式(帮助)?$',
          fnc: 'modeHelp'
        },
        {
          reg: '^#chatgpt版本(信息)',
          fnc: 'versionChatGPTPlugin'
        },
        {
          reg: '^#chatgpt(本群)?(群\\d+)?(闭嘴|关机|休眠|下班)',
          fnc: 'shutUp',
          permission: 'master'
        },
        {
          reg: '^#chatgpt(本群)?(群\\d+)?(张嘴|开口|说话|上班)$',
          fnc: 'openMouth',
          permission: 'master'
        },
        {
          reg: '^#chatgpt查看?(闭嘴|关机|休眠|下班)列表$',
          fnc: 'listShutUp',
          permission: 'master'
        },
        {
          reg: '^#chatgpt设置(API|key)(Key|key)$',
          fnc: 'setAPIKey',
          permission: 'master'
        },
        {
          reg: '^#chatgpt设置(API|api)设定$',
          fnc: 'setAPIPromptPrefix',
          permission: 'master'
        },
        {
          reg: '^#chatgpt查看(API|api)设定$',
          fnc: 'queryAPIPromptPrefix',
          permission: 'master'
        },
        {
          reg: '^#chatgpt(打开|关闭|设置)?全局((文本模式|图片模式|语音模式|((azure|vits|vox)?语音角色|角色语音|角色).*)|回复帮助)$',
          fnc: 'setDefaultReplySetting',
          permission: 'master'
        },
        {
          /** 命令正则匹配 */
          reg: '^#(chatgpt)?(关闭|打开)群聊上下文$',
          /** 执行方法 */
          fnc: 'enableGroupContext',
          permission: 'master'
        },
        {
          reg: '^#chatgpt(允许|禁止|打开|关闭|同意)私聊$',
          fnc: 'enablePrivateChat',
          permission: 'master'
        },
        {
          reg: '^#(chatgpt)?(设置|修改)管理密码',
          fnc: 'setAdminPassword',
          permission: 'master'
        },
        {
          reg: '^#(chatgpt)?(设置|修改)用户密码',
          fnc: 'setUserPassword'
        },
        {
          reg: '^#(chatgpt)?工具箱',
          fnc: 'toolsPage',
          permission: 'master'
        },
        {
          reg: '^#chatgpt系统(设置|配置|管理)',
          fnc: 'adminPage',
          permission: 'master'
        },
        {
          reg: '^#chatgpt用户(设置|配置|管理)',
          fnc: 'userPage'
        },
        {
          reg: '^#?(chatgpt)(对话|管理|娱乐|绘图|人物设定|聊天记录)?指令表(帮助|搜索(.+))?',
          fnc: 'commandHelp'
        },
        {
          reg: '^#(chatgpt)?语音切换.*',
          fnc: 'ttsSwitch',
          permission: 'master'
        },
        {
          reg: '^#(chatgpt)?(vits|azure|vox)?语音(角色列表|服务)$',
          fnc: 'getTTSRoleList'
        },
        {
          reg: '^#(chatgpt)?查看回复设置$',
          fnc: 'viewUserSetting'
        },
        {
          reg: '^#chatgpt导出配置',
          fnc: 'exportConfig',
          permission: 'master'
        },
        {
          reg: '^#chatgpt导入配置',
          fnc: 'importConfig',
          permission: 'master'
        },
        {
          reg: '^#chatgpt(开启|关闭)智能模式$',
          fnc: 'switchSmartMode',
          permission: 'master'
        },
        {
          reg: '^#chatgpt模型列表$',
          fnc: 'viewAPIModel'
        },
        {
          reg: '^#chatgpt设置(API|api)模型$',
          fnc: 'setAPIModel',
          permission: 'master'
        },
        {
          reg: '^#chatgpt设置(API|api)反代$',
          fnc: 'setOpenAiBaseUrl',
          permission: 'master'
        },
        {
          reg: '^#chatgpt查看当前配置$',
          fnc: 'queryConfig',
          permission: 'master'
        },
        {
          reg: '^#chatgpt(开启|关闭)(api|API)流$',
          fnc: 'switchStream',
          permission: 'master'
        },
        {
          reg: '^#chatgpt(开启|关闭)(工具箱|后台服务)$',
          fnc: 'switchToolbox',
          permission: 'master'
        },
        {

          reg: '^#chatgpt(开启|关闭)(伪人|bym)$',
          fnc: 'switchBYM',
          permission: 'master'
        },
      ]
    })
    this.task = []
    this.reply = async (msg, quote, data) => {
      if (!Config.enableMd) {
        return e.reply(msg, quote, data)
      }
      let handler = e.runtime?.handler || {}
      const btns = await handler.call('chatgpt.button.post', this.e)
      if (btns) {
        const btnElement = {
          type: 'button',
          content: btns
        }
        if (Array.isArray(msg)) {
          msg.push(btnElement)
        } else {
          msg = [msg, btnElement]
        }
      }
      return e.reply(msg, quote, data)
    }
  }

  async viewUserSetting (e) {
    const userSetting = await getUserReplySetting(this.e)
    const replyMsg = `${this.e.sender.user_id}的回复设置:
图片模式: ${userSetting.usePicture === true ? '开启' : '关闭'}
语音模式: ${userSetting.useTTS === true ? '开启' : '关闭'}
Vits语音角色: ${userSetting.ttsRole}
Azure语音角色: ${userSetting.ttsRoleAzure}
VoiceVox语音角色: ${userSetting.ttsRoleVoiceVox}
${userSetting.useTTS === true ? '当前语音模式为' + Config.ttsMode : ''}`
    await this.reply(replyMsg.replace(/\n\s*$/, ''), e.isGroup)
    return true
  }

  async getTTSRoleList (e) {
    const matchCommand = e.msg.match(/^#(chatgpt)?(vits|azure|vox)?语音(服务|角色列表)/)
    if (matchCommand[3] === '服务') {
      await this.reply(`当前支持vox、vits、azure语音服务，可使用'#(vox|azure|vits)语音角色列表'查看支持的语音角色。

vits语音：主要有赛马娘，原神中文，原神日语，崩坏 3 的音色、结果有随机性，语调可能很奇怪。

vox语音：Voicevox 是一款由日本 DeNA 开发的语音合成软件，它可以将文本转换为自然流畅的语音。Voicevox 支持多种语言和声音，可以用于制作各种语音内容，如动画、游戏、广告等。Voicevox 还提供了丰富的调整选项，可以调整声音的音调、速度、音量等参数，以满足不同需求。除了桌面版软件外，Voicevox 还提供了 Web 版本和 API 接口，方便开发者在各种平台上使用。

azure语音：Azure 语音是微软 Azure 平台提供的一项语音服务，它可以帮助开发者将语音转换为文本、将文本转换为语音、实现自然语言理解和对话等功能。Azure 语音支持多种语言和声音，可以用于构建各种语音应用程序，如智能客服、语音助手、自动化电话系统等。Azure 语音还提供了丰富的 API 和 SDK，方便开发者在各种平台上集成使用。
      `)
      return true
    }
    let userReplySetting = await getUserReplySetting(this.e)
    if (!userReplySetting.useTTS && matchCommand[2] === undefined) {
      await this.reply('当前不是语音模式,如果想查看不同语音模式下支持的角色列表,可使用"#(vox|azure|vits)语音角色列表"查看')
      return false
    }
    let ttsMode = Config.ttsMode
    let roleList = []
    if (matchCommand[2] === 'vits') {
      roleList = getVitsRoleList(this.e)
    } else if (matchCommand[2] === 'vox') {
      roleList = getVoicevoxRoleList()
    } else if (matchCommand[2] === 'azure') {
      roleList = getAzureRoleList()
    } else if (matchCommand[2] === undefined) {
      switch (ttsMode) {
        case 'vits-uma-genshin-honkai':
          roleList = getVitsRoleList(this.e)
          break
        case 'voicevox':
          roleList = getVoicevoxRoleList()
          break
        case 'azure':
          roleList = getAzureRoleList()
          break
        default:
          break
      }
    } else {
      await this.reply('设置错误,请使用"#chatgpt语音服务"查看支持的语音配置')
      return false
    }
    if (roleList.length > 300) {
      let chunks = roleList.match(/[^、]+(?:、[^、]+){0,30}/g)
      roleList = await makeForwardMsg(e, chunks, `${Config.ttsMode}语音角色列表`)
    }
    await this.reply(roleList)
  }

  async ttsSwitch (e) {
    let userReplySetting = await getUserReplySetting(this.e)
    if (!userReplySetting.useTTS) {
      let replyMsg
      if (userReplySetting.usePicture) {
        replyMsg = `当前为${!userReplySetting.useTTS ? '图片模式' : ''}，请先切换到语音模式吧~`
      } else {
        replyMsg = `当前为${!userReplySetting.useTTS ? '文本模式' : ''}，请先切换到语音模式吧~`
      }
      await this.reply(replyMsg, e.isGroup)
      return false
    }
    let regExp = /#语音切换(.*)/
    let ttsMode = e.msg.match(regExp)[1]
    if (['vits', 'azure', 'voicevox'].includes(ttsMode)) {
      if (ttsMode === 'vits') {
        Config.ttsMode = 'vits-uma-genshin-honkai'
      } else {
        Config.ttsMode = ttsMode
      }
      await this.reply(`语音回复已切换至${Config.ttsMode}模式${Config.ttsMode === 'azure' ? '，建议重新开始对话以获得更好的对话效果！' : ''}`)
    } else {
      await this.reply('暂不支持此模式，当前支持vits，azure，voicevox。')
    }
    return false
  }

  async commandHelp (e) {
    if (/^#(chatgpt)?指令表帮助$/.exec(e.msg.trim())) {
      await this.reply('#chatgpt指令表: 查看本插件的所有指令\n' +
        '#chatgpt(对话|管理|娱乐|人物设定|聊天记录)指令表: 查看对应功能分类的指令表\n' +
        '#chatgpt指令表搜索xxx: 查看包含对应关键词的指令')
      return false
    }
    const categories = {
      对话: '对话',
      管理: '管理',
      娱乐: '娱乐',
      人物设定: '人物设定',
      聊天记录: '聊天记录'
    }

    function getCategory (e, plugin) {
      for (const key in categories) {
        if (e.msg.includes(key) && plugin.name.includes(categories[key])) {
          return '功能名称: '
        }
      }
      return ''
    }
    const commandSet = []
    const plugins = await Promise.all(loader.priority.map(p => new p.class()))

    for (const plugin of plugins) {
      const name = plugin.name
      const rule = plugin.rule
      if (/^chatgpt/i.test(name) && rule) {
        commandSet.push({ name, dsc: plugin.dsc, rule })
      }
    }
    if (/^#(chatgpt)?指令表搜索(.+)/.test(e.msg.trim())) {
      let cmd = e.msg.trim().match(/#(chatgpt)?指令表搜索(.+)/)[2]
      if (!cmd) {
        await this.reply('(⊙ˍ⊙)')
        return 0
      } else {
        let searchResults = []
        commandSet.forEach(plugin => {
          plugin.rule.forEach(item => {
            if (item.reg.toLowerCase().includes(cmd.toLowerCase())) {
              searchResults.push(item.reg)
            }
          })
        })
        if (!searchResults.length) {
          await this.reply('没有找到符合的结果，换个关键词吧！', e.isGroup)
          return 0
        } else if (searchResults.length <= 5) {
          await this.reply(searchResults.join('\n'), e.isGroup)
          return 1
        } else {
          let msg = await makeForwardMsg(e, searchResults, e.msg.slice(1).startsWith('chatgpt') ? e.msg.slice(8) : 'chatgpt' + e.msg.slice(1))
          await this.reply(msg)
          return 1
        }
      }
    }
    const generatePrompt = (plugin, command) => {
      const category = getCategory(e, plugin)
      const commandsStr = command.length ? `正则指令:\n${command.join('\n')}\n` : '正则指令: 无\n'
      const description = `功能介绍：${plugin.dsc}\n`
      return `${category}${plugin.name}\n${description}${commandsStr}`
    }

    const prompts = []
    for (const plugin of commandSet) {
      const commands = plugin.rule.map(v => v.reg.includes('[#*0-9]') ? '表情合成功能只需要发送两个emoji表情即可' : v.reg)
      const category = getCategory(e, plugin)
      if (category || (!e.msg.includes('对话') && !e.msg.includes('管理') && !e.msg.includes('娱乐') && !e.msg.includes('人物设定') && !e.msg.includes('聊天记录'))) {
        prompts.push(generatePrompt(plugin, commands))
      }
    }
    let msg = await makeForwardMsg(e, prompts, e.msg.slice(1).startsWith('chatgpt') ? e.msg.slice(1) : ('chatgpt' + e.msg.slice(1)))
    await this.reply(msg)
    return true
  }

  async enablePrivateChat (e) {
    Config.enablePrivateChat = !!e.msg.match(/(允许|打开|同意)/)
    await this.reply('设置成功', e.isGroup)
    return false
  }

  async enableGroupContext (e) {
    const reg = /(关闭|打开)/
    const match = e.msg.match(reg)
    if (match) {
      const action = match[1]
      if (action === '关闭') {
        Config.enableGroupContext = false // 关闭
        await this.reply('已关闭群聊上下文功能', true)
      } else {
        Config.enableGroupContext = true // 打开
        await this.reply('已打开群聊上下文功能', true)
      }
    }
    return false
  }

  async setDefaultReplySetting (e) {
    const reg = /^#chatgpt(打开|关闭|设置)?全局((文本模式|图片模式|语音模式|((azure|vits|vox)?语音角色|角色语音|角色)(.*))|回复帮助)/
    const matchCommand = e.msg.match(reg)
    const settingType = matchCommand[2]
    let replyMsg = ''
    let ttsSupportKinds = []
    if (Config.azureTTSKey) ttsSupportKinds.push(1)
    if (Config.ttsSpace) ttsSupportKinds.push(2)
    if (Config.voicevoxSpace) ttsSupportKinds.push(3)
    switch (settingType) {
      case '图片模式':
        if (matchCommand[1] === '打开') {
          Config.defaultUsePicture = true
          Config.defaultUseTTS = false
          replyMsg = 'ChatGPT将默认以图片回复'
        } else if (matchCommand[1] === '关闭') {
          Config.defaultUsePicture = false
          if (Config.defaultUseTTS) {
            replyMsg = 'ChatGPT将默认以语音回复'
          } else {
            replyMsg = 'ChatGPT将默认以文本回复'
          }
        } else if (matchCommand[1] === '设置') {
          replyMsg = '请使用“#chatgpt打开全局图片模式”或“#chatgpt关闭全局图片模式”命令来设置回复模式'
        } break
      case '文本模式':
        if (matchCommand[1] === '打开') {
          Config.defaultUsePicture = false
          Config.defaultUseTTS = false
          replyMsg = 'ChatGPT将默认以文本回复'
        } else if (matchCommand[1] === '关闭') {
          if (Config.defaultUseTTS) {
            replyMsg = 'ChatGPT将默认以语音回复'
          } else if (Config.defaultUsePicture) {
            replyMsg = 'ChatGPT将默认以图片回复'
          } else {
            Config.defaultUseTTS = true
            replyMsg = 'ChatGPT将默认以语音回复'
          }
        } else if (matchCommand[1] === '设置') {
          replyMsg = '请使用“#chatgpt打开全局文本模式”或“#chatgpt关闭全局文本模式”命令来设置回复模式'
        } break
      case '语音模式':
        if (!ttsSupportKinds.length) {
          replyMsg = '您没有配置任何语音服务，请前往锅巴面板进行配置'
          break
        }
        if (matchCommand[1] === '打开') {
          Config.defaultUseTTS = true
          Config.defaultUsePicture = false
          replyMsg = 'ChatGPT将默认以语音回复'
        } else if (matchCommand[1] === '关闭') {
          Config.defaultUseTTS = false
          if (Config.defaultUsePicture) {
            replyMsg = 'ChatGPT将默认以图片回复'
          } else {
            replyMsg = 'ChatGPT将默认以文本回复'
          }
        } else if (matchCommand[1] === '设置') {
          replyMsg = '请使用“#chatgpt打开全局语音模式”或“#chatgpt关闭全局语音模式”命令来设置回复模式'
        } break
      case '回复帮助':
        replyMsg = '可使用以下命令配置全局回复:\n#chatgpt(打开/关闭)全局(语音/图片/文本)模式\n#chatgpt设置全局(vox|azure|vits)语音角色+角色名称(留空则为随机)\n'
        break
      default:
        if (!ttsSupportKinds) {
          replyMsg = '您没有配置任何语音服务，请前往锅巴面板进行配置'
          break
        }
        if (settingType.match(/(语音角色|角色语音|角色)/)) {
          const voiceKind = matchCommand[5]
          let speaker = matchCommand[6] || ''
          if (voiceKind === undefined) {
            await this.reply('请选择需要设置的语音类型。使用"#chatgpt语音服务"查看支持的语音类型')
            return false
          }
          if (!speaker.length || speaker === '随机') {
            replyMsg = `设置成功,ChatGpt将在${voiceKind}语音模式下随机挑选角色进行回复`
            if (voiceKind === 'vits') Config.defaultTTSRole = '随机'
            if (voiceKind === 'azure') Config.azureTTSSpeaker = '随机'
            if (voiceKind === 'vox') Config.voicevoxTTSSpeaker = '随机'
          } else {
            if (ttsSupportKinds.includes(1) && voiceKind === 'azure') {
              if (getAzureRoleList().includes(speaker)) {
                Config.defaultUseTTS = azureRoleList.filter(s => s.name === speaker)[0].code
                replyMsg = `ChatGPT默认语音角色已被设置为“${speaker}”`
              } else {
                await this.reply(`抱歉，没有"${speaker}"这个角色，目前azure模式下支持的角色有${azureRoleList.map(item => item.name).join('、')}`)
                return false
              }
            } else if (ttsSupportKinds.includes(2) && voiceKind === 'vits') {
              const ttsRole = convertSpeaker(speaker)
              if (vitsRoleList.includes(ttsRole)) {
                Config.defaultTTSRole = ttsRole
                replyMsg = `ChatGPT默认语音角色已被设置为“${ttsRole}”`
              } else {
                replyMsg = `抱歉，我还不认识“${ttsRole}”这个语音角色,可使用'#vits角色列表'查看可配置的角色`
              }
            } else if (ttsSupportKinds.includes(3) && voiceKind === 'vox') {
              if (getVoicevoxRoleList().includes(speaker)) {
                let regex = /^(.*?)-(.*)$/
                let match = regex.exec(speaker)
                let style = null
                if (match) {
                  speaker = match[1]
                  style = match[2]
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
                Config.ttsRoleVoiceVox = chosen[0].name + (style ? `-${style}` : '')
                replyMsg = `ChatGPT默认语音角色已被设置为“${speaker}”`
              } else {
                await this.reply(`抱歉，没有"${speaker}"这个角色，目前voicevox模式下支持的角色有${voxRoleList.map(item => item.name).join('、')}`)
                return false
              }
            } else {
              replyMsg = `${voiceKind}语音角色设置错误,请检查语音配置~`
            }
          }
        } else {
          replyMsg = "无法识别的设置类型\n请使用'#chatgpt全局回复帮助'查看正确命令"
        }
    }
    await this.reply(replyMsg, true)
  }

  async turnOnConfirm (e) {
    await redis.set('CHATGPT:CONFIRM', 'on')
    await this.reply('已开启消息确认', true)
    return false
  }

  async turnOffConfirm (e) {
    await redis.set('CHATGPT:CONFIRM', 'off')
    await this.reply('已关闭消息确认', true)
    return false
  }

  async useOpenAIAPIBasedSolution (e) {
    let use = resolveProviderModeForRuntime(await redis.get('CHATGPT:USE'), logger)
    if (use !== 'api') {
      await redis.set('CHATGPT:USE', 'api')
      await this.reply('已切换到基于OpenAI API的解决方案，如果已经对话过建议执行`#结束对话`避免引起404错误')
    } else {
      await this.reply('当前已经是API模式了')
    }
  }

  async checkAuth (e) {
    if (!e.isMaster) {
      this.reply(`只有主人才能命令ChatGPT哦~
    (*/ω＼*)`)
      return false
    }
    return true
  }

  async versionChatGPTPlugin (e) {
    let img = await renderUrl(e, `http://127.0.0.1:${Config.serverPort || 3321}/version`, { Viewport: { width: 800, height: 600 }, retType: 'base64' })
    this.reply(img)
  }

  async modeHelp () {
    resolveProviderModeForRuntime(await redis.get('CHATGPT:USE'), logger)
    await this.reply('GroupMate 当前仅支持 OpenAI-compatible API。')
  }

  async shutUp (e) {
    let duration = e.msg.replace(/^#chatgpt(本群)?(群\d+)?(关闭|闭嘴|关机|休眠|下班)/, '')
    let scope
    let time = 3600000
    if (duration === '永久') {
      time = 0
    } else if (duration) {
      time = parseDuration(duration)
    }
    const match = e.msg.match(/#chatgpt群(\d+)?(关闭|闭嘴|关机|休眠|下班)(.*)/)
    if (e.msg.indexOf('本群') > -1) {
      if (e.isGroup) {
        scope = e.group.group_id
        if (await redis.get(`CHATGPT:SHUT_UP:${scope}`)) {
          await redis.del(`CHATGPT:SHUT_UP:${scope}`)
          await redis.set(`CHATGPT:SHUT_UP:${scope}`, '1', { EX: time })
          await this.reply(`好的，已切换休眠状态：倒计时${formatDuration(time)}`)
        } else {
          await redis.set(`CHATGPT:SHUT_UP:${scope}`, '1', { EX: time })
          await this.reply(`好的，已切换休眠状态：倒计时${formatDuration(time)}`)
        }
      } else {
        await this.reply('主人，这里好像不是群哦')
        return false
      }
    } else if (match) {
      const groupId = parseInt(match[1], 10)
      if (e.bot.getGroupList().get(groupId)) {
        if (await redis.get(`CHATGPT:SHUT_UP:${groupId}`)) {
          await redis.del(`CHATGPT:SHUT_UP:${groupId}`)
          await redis.set(`CHATGPT:SHUT_UP:${groupId}`, '1', { EX: time })
          await this.reply(`好的，即将在群${groupId}中休眠${formatDuration(time)}`)
        } else {
          await redis.set(`CHATGPT:SHUT_UP:${groupId}`, '1', { EX: time })
          await this.reply(`好的，即将在群${groupId}中休眠${formatDuration(time)}`)
        }
      } else {
        await this.reply('主人还没告诉我群号呢')
        return false
      }
    } else {
      if (await redis.get('CHATGPT:SHUT_UP:ALL')) {
        await redis.del('CHATGPT:SHUT_UP:ALL')
        await redis.set('CHATGPT:SHUT_UP:ALL', '1', { EX: time })
        await this.reply(`好的，我会延长休眠时间${formatDuration(time)}`)
      } else {
        await redis.set('CHATGPT:SHUT_UP:ALL', '1', { EX: time })
        await this.reply(`好的，我会延长休眠时间${formatDuration(time)}`)
      }
    }
  }

  async openMouth (e) {
    const match = e.msg.match(/^#chatgpt群(\d+)/)
    if (e.msg.indexOf('本群') > -1) {
      if (await redis.get('CHATGPT:SHUT_UP:ALL')) {
        await this.reply('当前为休眠模式，没办法做出回应呢')
        return false
      }
      if (e.isGroup) {
        let scope = e.group.group_id
        if (await redis.get(`CHATGPT:SHUT_UP:${scope}`)) {
          await redis.del(`CHATGPT:SHUT_UP:${scope}`)
          await this.reply('好的主人，我又可以和大家聊天啦')
        } else {
          await this.reply('主人，我已经启动过了哦')
        }
      } else {
        await this.reply('主人，这里好像不是群哦')
        return false
      }
    } else if (match) {
      if (await redis.get('CHATGPT:SHUT_UP:ALL')) {
        await this.reply('当前为休眠模式，没办法做出回应呢')
        return false
      }
      const groupId = parseInt(match[1], 10)
      if (e.bot.getGroupList().get(groupId)) {
        if (await redis.get(`CHATGPT:SHUT_UP:${groupId}`)) {
          await redis.del(`CHATGPT:SHUT_UP:${groupId}`)
          await this.reply(`好的主人，我终于又可以在群${groupId}和大家聊天了`)
        } else {
          await this.reply(`主人，我在群${groupId}中已经是启动状态了哦`)
        }
      } else {
        await this.reply('主人还没告诉我群号呢')
        return false
      }
    } else {
      let keys = await redis.keys('CHATGPT:SHUT_UP:*')
      if (await redis.get('CHATGPT:SHUT_UP:ALL')) {
        await redis.del('CHATGPT:SHUT_UP:ALL')
        for (let i = 0; i < keys.length; i++) {
          await redis.del(keys[i])
        }
        await this.reply('好的，我会开启所有群聊响应')
      } else if (keys || keys.length > 0) {
        for (let i = 0; i < keys.length; i++) {
          await redis.del(keys[i])
        }
        await this.reply('已经开启过全群响应啦')
      } else {
        await this.reply('我没有在任何群休眠哦')
      }
    }
  }

  async listShutUp () {
    let keys = await redis.keys('CHATGPT:SHUT_UP:*')
    if (!keys || keys.length === 0) {
      await this.reply('已经开启过全群响应啦', true)
    } else {
      let list = []
      for (let i = 0; i < keys.length; i++) {
        let key = keys[i]
        let groupId = key.replace('CHATGPT:SHUT_UP:', '')
        let ttl = await redis.ttl(key)
        let ttlFormat = formatDuration(ttl)
        list.push({ groupId, ttlFormat })
      }
      await this.reply(list.map(item => item.groupId !== 'ALL' ? `群聊${item.groupId}: ${item.ttlFormat}` : `全局: ${item.ttlFormat}`).join('\n'))
    }
  }

  async setAPIKey (e) {
    this.setContext('saveAPIKey')
    await this.reply('请发送OpenAI API Key.', true)
    return false
  }

  async saveAPIKey () {
    if (!this.e.msg) return
    let token = this.e.msg
    if (!token.startsWith('sk-') && !token.startsWith('sess-')) {
      await this.reply('OpenAI API Key格式错误。如果是格式特殊的非官方Key请前往锅巴或工具箱手动设置', true)
      this.finish('saveAPIKey')
      return
    }
    // todo
    Config.apiKey = token
    await this.reply('OpenAI API Key设置成功', true)
    this.finish('saveAPIKey')
  }

  async setAPIPromptPrefix (e) {
    this.setContext('saveAPIPromptPrefix')
    await this.reply('请发送用于API模式的设定', true)
    return false
  }

  async saveAPIPromptPrefix (e) {
    if (!this.e.msg) return
    if (this.e.msg === '取消') {
      await this.reply('已取消设置API设定', true)
      this.finish('saveAPIPromptPrefix')
      return
    }
    // todo
    Config.promptPrefixOverride = this.e.msg
    await this.reply('API模式的设定设置成功', true)
    this.finish('saveAPIPromptPrefix')
  }

  async queryAPIPromptPrefix (e) {
    await this.reply(Config.promptPrefixOverride, true)
  }

  async setAdminPassword (e) {
    if (e.isGroup || !e.isPrivate) {
      await this.reply('请私聊发送命令', true)
      return true
    }
    this.setContext('saveAdminPassword')
    await this.reply('请发送系统管理密码', true)
    return false
  }

  async setUserPassword (e) {
    if (e.isGroup || !e.isPrivate) {
      await this.reply('请私聊发送命令', true)
      return true
    }
    this.setContext('saveUserPassword')
    await this.reply('请发送系统用户密码', true)
    return false
  }

  async saveAdminPassword (e) {
    if (!this.e.msg) return
    const passwd = this.e.msg
    await redis.set('CHATGPT:ADMIN_PASSWD', md5(passwd))
    await this.reply('设置成功', true)
    this.finish('saveAdminPassword')
  }

  async saveUserPassword (e) {
    if (!this.e.msg) return
    const passwd = this.e.msg
    const dir = 'resources/ChatGPTCache/user'
    const filename = `${this.e.user_id}.json`
    const filepath = path.join(dir, filename)
    fs.mkdirSync(dir, { recursive: true })
    if (fs.existsSync(filepath)) {
      fs.readFile(filepath, 'utf8', (err, data) => {
        if (err) {
          console.error(err)
          return
        }
        const config = JSON.parse(data)
        config.passwd = md5(passwd)
        fs.writeFile(filepath, JSON.stringify(config), 'utf8', (err) => {
          if (err) {
            console.error(err)
          }
        })
      })
    } else {
      fs.writeFile(filepath, JSON.stringify({
        user: this.e.user_id,
        passwd: md5(passwd),
        chat: []
      }), 'utf8', (err) => {
        if (err) {
          console.error(err)
        }
      })
    }
    await this.reply('设置完成', true)
    this.finish('saveUserPassword')
  }

  async adminPage (e) {
    if (!Config.groupAdminPage && (e.isGroup || !e.isPrivate)) {
      await this.reply('请私聊发送命令', true)
      return true
    }
    const viewHost = Config.serverHost ? `http://${Config.serverHost}/` : `http://${await getPublicIP()}:${Config.serverPort || 3321}/`
    await this.reply(`请登录${viewHost}进行系统配置`, true)
  }

  async userPage (e) {
    if (!Config.groupAdminPage && (e.isGroup || !e.isPrivate)) {
      await this.reply('请私聊发送命令', true)
      return true
    }
    const viewHost = Config.serverHost ? `http://${Config.serverHost}/` : `http://${await getPublicIP()}:${Config.serverPort || 3321}/`
    await this.reply(`请登录${viewHost}进行系统配置`, true)
  }

  async toolsPage (e) {
    if (e.isGroup || !e.isPrivate) {
      await this.reply('请私聊发送命令', true)
      return true
    }
    const viewHost = Config.serverHost ? `http://${Config.serverHost}/` : `http://${await getPublicIP()}:${Config.serverPort || 3321}/`
    const otp = randomString(6)
    await redis.set(
      'CHATGPT:SERVER_QUICK',
      otp,
      { EX: 60000 }
    )
    await this.reply(`请登录http://tools.alcedogroup.com/login?server=${viewHost}&otp=${otp}`, true)
  }

  async exportConfig (e) {
    if (e.isGroup || !e.isPrivate) {
      await this.reply('请私聊发送命令', true)
      return true
    }
    let redisConfig = {}
    if (await redis.exists('CHATGPT:CONFIRM') != 0) {
      redisConfig.turnConfirm = await redis.get('CHATGPT:CONFIRM') === 'on'
    }
    if (await redis.exists('CHATGPT:USE') != 0) {
      redisConfig.useMode = resolveProviderModeForRuntime(await redis.get('CHATGPT:USE'), logger)
    }
    const filepath = resolvePluginPath('resources', 'view', 'setting_view.json')
    const configView = JSON.parse(fs.readFileSync(filepath, 'utf8'))
    const chatConfig = Object.fromEntries(
      supportedConfigKeys.map(key => [key, Config[key]])
    )
    const configJson = JSON.stringify({
      chatConfig,
      redisConfig,
      view: configView
    })
    const buf = Buffer.from(configJson)
    e.friend.sendFile(buf, `GroupMate Config ${Date.now()}.json`)
    return true
  }

  async importConfig (e) {
    if (e.isGroup || !e.isPrivate) {
      await this.reply('请私聊发送命令', true)
      return true
    }
    this.setContext('doImportConfig')
    await this.reply('请发送配置文件')
  }

  async doImportConfig (e) {
    const file = this.e.message.find(item => item.type === 'file')
    if (file) {
      const fileUrl = await this.e.friend.getFileUrl(file.fid)
      if (fileUrl) {
        try {
          let changeConfig = []
          const response = await fetch(fileUrl)
          const data = await response.json()
          const chatdata = selectImportableConfig(
            migrateLegacyCrossChannelPolicies(data.chatConfig || {}),
            supportedConfigKeys
          )
          for (let [keyPath, value] of Object.entries(chatdata)) {
            if (keyPath === 'blockWords' || keyPath === 'promptBlockWords' || keyPath === 'initiativeChatGroups') { value = value.toString().split(/[,，;；|]/) }
            if (Config[keyPath] != value) {
              changeConfig.push({
                item: keyPath,
                value: typeof (value) === 'object' ? JSON.stringify(value) : value,
                old: typeof (Config[keyPath]) === 'object' ? JSON.stringify(Config[keyPath]) : Config[keyPath],
                type: 'config'
              })
              Config[keyPath] = value
            }
          }
          const redisConfig = data.redisConfig || {}
          if (redisConfig.turnConfirm != null) {
            changeConfig.push({
              item: 'turnConfirm',
              value: redisConfig.turnConfirm ? 'on' : 'off',
              old: await redis.get('CHATGPT:CONFIRM'),
              type: 'redis'
            })
            await redis.set('CHATGPT:CONFIRM', redisConfig.turnConfirm ? 'on' : 'off')
          }
          if (redisConfig.useMode != null) {
            const importedMode = resolveProviderMode(redisConfig.useMode)
            if (importedMode.migrated) {
              logger.info(providerModeMigrationEvent)
            }
          }
          await this.reply(await makeForwardMsg(this.e, changeConfig.map(msg => `修改项:${msg.item}\n旧数据\n\n${msg.old}\n\n新数据\n ${msg.value}`)))
        } catch (error) {
          console.error(error)
          await this.reply('配置文件错误')
        }
      }
    } else {
      await this.reply('未找到配置文件', false)
      return false
    }

    this.finish('doImportConfig')
  }

  async switchSmartMode (e) {
    if (e.msg.includes('开启')) {
      if (Config.smartMode) {
        await this.reply('已经开启了')
        return
      }
      Config.smartMode = true
      await this.reply('好的，已经打开智能模式，注意API额度哦。配合开启读取群聊上下文效果更佳！')
    } else {
      if (!Config.smartMode) {
        await this.reply('已经是关闭得了')
        return
      }
      Config.smartMode = false
      await this.reply('好的，已经关闭智能模式')
    }
  }

  async viewAPIModel (e) {
    const contents = [
      '仅列出部分模型以供参考',
      'gpt-3.5-turbo',
      'gpt-3.5-turbo-0301',
      'gpt-3.5-turbo-0613',
      'gpt-3.5-turbo-1106',
      'gpt-3.5-turbo-16k',
      'gpt-3.5-turbo-16k-0613',
      'gpt-4',
      'gpt-4-32k',
      'gpt-4-1106-preview'
    ]
    let modelList = []
    contents.forEach(value => {
      // console.log(value)
      modelList.push(value)
    })
    await this.reply(makeForwardMsg(e, modelList, '模型列表'))
  }

  async setAPIModel (e) {
    this.setContext('saveAPIModel')
    await this.reply('请发送API模型', true)
    return false
  }

  async saveAPIModel () {
    if (!this.e.msg) return
    let token = this.e.msg
    Config.model = token
    await this.reply('API模型设置成功', true)
    this.finish('saveAPIModel')
  }

  async setOpenAiBaseUrl (e) {
    this.setContext('saveOpenAiBaseUrl')
    await this.reply('请发送API反代', true)
    return false
  }

  async saveOpenAiBaseUrl () {
    if (!this.e.msg) return
    let token = this.e.msg
    // console.log(token.startsWith('http://') || token.startsWith('https://'))
    if (token.startsWith('http://') || token.startsWith('https://')) {
      Config.openAiBaseUrl = token
      await this.reply('API反代设置成功', true)
      this.finish('saveOpenAiBaseUrl')
      return
    }
    await this.reply('你的输入不是一个有效的URL,请检查是否含有http://或https://', true)
    this.finish('saveOpenAiBaseUrl')
  }

  async queryConfig (e) {
    resolveProviderModeForRuntime(await redis.get('CHATGPT:USE'), logger)
    let config = []
    config.push('当前 Provider：OpenAI-compatible API')
    config.push(`\n当前模型：${Config.model}`)
    config.push(`\n当前开启流式输出：${Config.apiStream}`)
    config.push(`\n当前开启主动群聊：${Config.enableBYM}`)
    config.push(`\n当前工具调用：${Config.smartMode}`)
    if (e.isPrivate) {
      config.push(`\n当前APIKey：${Config.apiKey}`)
      config.push(`\n当前API地址：${Config.openAiBaseUrl}`)
      config.push(`\n当前开启工具箱：${Config.enableToolbox}`)
    }
    this.reply(config)
  }

  async switchStream (e) {
    if (e.msg.includes('开启')) {
      if (Config.apiStream) {
        await this.reply('已经开启了')
        return
      }
      Config.apiStream = true
      await this.reply('好的，已经打开API流式输出')
    } else {
      if (!Config.apiStream) {
        await this.reply('已经是关闭得了')
        return
      }
      Config.apiStream = false
      await this.reply('好的，已经关闭API流式输出')
    }
  }

  async switchToolbox (e) {
    if (e.msg.includes('开启')) {
      if (Config.enableToolbox) {
        await this.reply('已经开启了')
        return
      }
      Config.enableToolbox = true
      await this.reply('开启中', true)
      await runServer()
      await this.reply('好的，已经打开工具箱')
    } else {
      if (!Config.enableToolbox) {
        await this.reply('已经是关闭的了')
        return
      }
      Config.enableToolbox = false
      await stopServer()
      await this.reply('好的，已经关闭工具箱')
    }
  }

  async switchBYM (e) {
    if (e.msg.includes('开启')) {
      if (Config.enableBYM) {
        await this.reply('已经开启了')
        return
      }
      Config.enableBYM = true
      await this.reply('开启中', true)
      await this.reply('好的，已经打开bym模式')
    } else {
      if (!Config.enableBYM) {
        await this.reply('已经是关闭的了')
        return
      }
      Config.enableBYM = false
      await this.reply('好的，已经关闭bym模式')
    }
  }

}
