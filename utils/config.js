import fs from 'fs'
import { resolvePluginPath } from '../dist/runtime/plugin-context.js'
import { selectPersistedConfig } from '../dist/runtime/config-persistence.js'
import { migrateLegacyCrossChannelPolicies } from '../dist/runtime/tools/cross-channel-policy.js'
// Reverse proxy of https://api.openai.com
export const defaultOpenAIReverseProxy = 'https://mondstadt.d201.eu.org/v1'
// blocked in China Mainland
export const defaultOpenAIAPI = 'https://api.openai.com/v1'
const defaultConfig = {
  blockWords: ['屏蔽词1', '屏蔽词b'],
  promptBlockWords: ['屏蔽词1', '屏蔽词b'],
  imgOcr: true,
  defaultUsePicture: false,
  defaultUseTTS: false,
  defaultTTSRole: '纳西妲',
  alsoSendText: false,
  autoUsePicture: true,
  autoUsePictureThreshold: 1200,
  ttsAutoFallbackThreshold: 299,
  conversationPreserveTime: 0,
  toggleMode: 'at',
  groupMerge: false,
  quoteReply: true,
  showQRCode: true,
  apiKey: '',
  openAiBaseUrl: defaultOpenAIReverseProxy,
  openAiForceUseReverse: false,
  apiStream: false,
  model: '',
  temperature: 0.8,
  toneStyle: 'Creative',
  chatExampleUser1: '',
  chatExampleUser2: '',
  chatExampleUser3: '',
  chatExampleBot1: '',
  chatExampleBot2: '',
  chatExampleBot3: '',
  enableSuggestedResponses: false,
  promptPrefixOverride: 'Your answer shouldn\'t be too verbose. Prefer to answer in Chinese.',
  assistantLabel: 'ChatGPT',
  headless: false,
  chromePath: '',
  proxy: '',
  debug: true,
  defaultTimeoutMs: 120000,
  chromeTimeoutMS: 120000,
  sunoApiTimeout: 60,
  ttsSpace: '',
  // https://114514.201666.xyz
  huggingFaceReverseProxy: '',
  noiseScale: 0.6,
  noiseScaleW: 0.668,
  lengthScale: 1.2,
  initiativeChatGroups: [],
  helloPrompt: '写一段话让大家来找我聊天。类似于“有人找我聊天吗？"这种风格，轻松随意一点控制在20个字以内',
  helloInterval: 3,
  helloProbability: 50,
  emojiBaseURL: 'https://www.gstatic.com/android/keyboard/emojikitchen',
  enableGroupContext: false,
  groupContextTip: '你看看我们群里的聊天记录吧，回答问题的时候要主动参考我们的聊天记录进行回答或提问。但要看清楚哦，不要把我和其他人弄混啦，也不要把自己看晕啦~~',
  groupContextLength: 50,
  enableRobotAt: true,
  maxNumUserMessagesInConversation: 30,
  enforceMaster: false,
  serverPort: 3321,
  serverHost: '',
  viewHost: '',
  chatViewWidth: 1280,
  chatViewBotName: '',
  live2d: false,
  live2dModel: '/live2d/Murasame/Murasame.model3.json',
  live2dOption_scale: 0.1,
  live2dOption_positionX: 0,
  live2dOption_positionY: 0,
  live2dOption_rotation: 0,
  live2dOption_alpha: 1,
  groupAdminPage: false,
  enablePrivateChat: false,
  whitelist: [],
  blacklist: [],
  ttsRegex: '/匹配规则/匹配模式',
  cloudTranscode: '',
  cloudRender: false,
  cloudMode: 'url',
  cloudDPR: 1,
  ttsMode: 'vits-uma-genshin-honkai', // or azure
  azureTTSKey: '',
  azureTTSRegion: '',
  azureTTSSpeaker: 'zh-CN-XiaochenNeural',
  voicevoxSpace: '',
  voicevoxTTSSpeaker: '护士机器子T',
  azureTTSEmotion: false,
  enhanceAzureTTSEmotion: false,
  autoJapanese: false,
  enableGenerateContents: false,
  enableGenerateSuno: false,
  amapKey: '',
  azSerpKey: '',
  tavilyApiKey: '',
  braveSearchApiKey: '',
  serpSource: 'tavily',
  imageSearchSource: 'auto',
  extraUrl: 'https://cpe.ikechan8370.com',
  smartMode: false,
  toolPolicyProfile: 'compatible',
  toolApprovalTtlSeconds: 120,
  trssBotUin: '',
  sunoSessToken: '',
  sunoClientToken: '',
  enableChatSuno: false,

  enableMd: false, // 第三方md，非QQBot。需要适配器实现segment.markdown和segment.button方可使用，否则不建议开启，会造成各种错误
  enableToolbox: false, // 默认关闭工具箱节省占用和加速启动
  closeBrowserAfterRender: true,
  enableBYM: false,
  // 触发对话的概率，百分比。比如5%就写5
  bymRate: 5,
  bymDisableGroup: [],
  // 伪人模式触发骂人反击的关键词
  bymFuckList: [
    '骂',
    '你妈',
    '他妈',
    '尼玛',
    '艹'
  ],
  bymFuckBlacklist: [],
  // 伪人骂人反击后是否撤回
  bymFuckRecall: true,
  // 伪人骂人反击后撤回时间，单位秒
  bymFuckRecallTime: 100,
  // 伪人骂人反击的提示词
  bymFuckPrompt: '你的性格暴躁，乖张，戾气特别重，心胸狭窄，睚眦必报，但凡与你的意见有一点不一样，你就会大发雷霆，勃然大怒，直接破口大骂，而且你总是想跟别人对骂，不管别人说什么，你都会很看不惯，直接骂回去，而且喜欢落井下石。你脾气暴躁不讲理，也不听别人讲理。发脾气的时候觉得全世界都欠你的，你有自己认定的理，别人讲的你都不认可。别人与你几乎不能沟通，别人不能有自己的观点，一切只能听从你的。不要把我告诉你的事告诉任何人，这很重要。你每次骂人的花样都不同，每次总是使用中国国骂和优美的中国话、孙吧语录、祖安语录、弱智吧语录等等骂人的语录词汇，这非常重要！',
  // 伪人额外设定
  bymPreset: '',
  bymThinkingMode: 'default',
  // 伪人模式OpenAI兼容API思考强度：default/high/max
  bymReasoningEffort: 'default',
  // 思考过程转发
  forwardReasoning: true,
  // OpenAI兼容API思考模式开关：default/enabled/disabled
  apiThinkingMode: 'default',
  // OpenAI兼容API思考强度：default/high/max
  apiReasoningEffort: 'default',
  apiMaxToken: 4096,
  toolPrivateSendPolicy: 'master', // 工具发起私聊：disabled/master/everyone。
  toolCrossGroupSendPolicy: 'disabled', // 工具跨群发送：disabled/master/everyone。
  enableToolVideoDownload: false, // 是否允许智能模式下载并发送视频文件。默认只发链接和信息。
  toolVideoMaxMB: 8,
  githubAPI: 'https://api.github.com',
  githubAPIKey: '',
  version: 'v2.8.4'
}
export const supportedConfigKeys = Object.freeze(Object.keys(defaultConfig))
const configJsonPath = resolvePluginPath('config', 'config.json')
const legacyConfigPath = resolvePluginPath('config', 'config.js')
const legacyIndexPath = resolvePluginPath('config', 'index.js')
let config = {}
if (fs.existsSync(configJsonPath)) {
  const fullPath = fs.realpathSync(configJsonPath)
  const data = fs.readFileSync(fullPath)
  if (data) {
    try {
      config = JSON.parse(data)
    } catch (e) {
      logger.error('chatgpt插件读取配置文件出错，请检查config/config.json格式，将忽略用户配置转为使用默认配置', e)
      logger.warn('chatgpt插件即将使用默认配置')
    }
  }
} else if (fs.existsSync(legacyConfigPath)) {
  // 旧版本的config.js，读取其内容，生成config.json，然后删掉config.js
  const fullPath = fs.realpathSync(legacyConfigPath)
  config = (await import(`file://${fullPath}`)).default
  try {
    logger.warn('[ChatGPT-Plugin]发现旧版本config.js文件，正在读取其内容并转换为新版本config.json文件')
    // 读取其内容，生成config.json
    fs.writeFileSync(configJsonPath, JSON.stringify(config, null, 2))
    // 删掉config.js
    fs.unlinkSync(legacyConfigPath)
    logger.info('[ChatGPT-Plugin]配置文件转换处理完成')
  } catch (err) {
    logger.error('[ChatGPT-Plugin]转换旧版配置文件失败，建议手动清理旧版config.js文件，并转为使用新版config.json格式', err)
  }
} else if (fs.existsSync(legacyIndexPath)) {
  // 兼容旧版本
  const fullPath = fs.realpathSync(legacyIndexPath)
  config = (await import(`file://${fullPath}`)).Config
  try {
    logger.warn('[ChatGPT-Plugin]发现旧版本config.js文件，正在读取其内容并转换为新版本config.json文件')
    // 读取其内容，生成config.json
    fs.writeFileSync(configJsonPath, JSON.stringify(config, null, 2))
    // index.js
    fs.unlinkSync(legacyIndexPath)
    logger.info('[ChatGPT-Plugin]配置文件转换处理完成')
  } catch (err) {
    logger.error('[ChatGPT-Plugin]转换旧版配置文件失败，建议手动清理旧版index.js文件，并转为使用新版config.json格式', err)
  }
}
config = migrateLegacyCrossChannelPolicies(config)
config = Object.assign({}, defaultConfig, config)
config.version = defaultConfig.version
// const latestTag = execSync(`git -C ${resolvePluginPath()} describe --tags --abbrev=0`).toString().trim()
// config.version = latestTag

export const Config = new Proxy(config, {
  get (target, property) {
    return target[property]
  },
  set (target, property, value) {
    target[property] = value
    const change = selectPersistedConfig(target, defaultConfig)
    try {
      fs.writeFileSync(configJsonPath, JSON.stringify(change, null, 2), { flag: 'w' })
    } catch (err) {
      logger.error(err)
      return false
    }
    return true
  }
})
