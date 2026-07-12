import { Config } from './utils/config.js'
import { speakers } from './utils/tts.js'
import { supportConfigurations as azureRoleList } from './utils/tts/microsoft-azure.js'
import { supportConfigurations as voxRoleList } from './utils/tts/voicevox.js'
import { pluginId, repositoryUrl } from './dist/runtime/plugin-context.js'

export function supportGuoba () {
  return {
    pluginInfo: {
      name: pluginId,
      title: 'GroupMate',
      author: 'Old-Second',
      authorLink: 'https://github.com/Old-Second',
      link: repositoryUrl,
      isV3: true,
      isV2: false,
      description: '自然参与 QQ 群聊、执行授权群管理并完成简单任务的群原生智能成员',
      icon: 'simple-icons:openai',
      iconColor: '#00c3ff'
    },
    configInfo: {
      schemas: [
        {
          label: '基础设置',
          component: 'Divider'
        },
        {
          field: 'toggleMode',
          label: '触发方式',
          bottomHelpMessage: 'at 模式下只有 at 机器人才会回复；前缀模式使用 #chat。',
          component: 'Select',
          componentProps: {
            options: [
              { label: 'at', value: 'at' },
              { label: '#chat', value: 'prefix' }
            ]
          }
        },
        {
          field: 'assistantLabel',
          label: '群内名字',
          component: 'Input'
        },
        {
          field: 'enablePrivateChat',
          label: '允许私聊',
          component: 'Switch'
        },
        {
          field: 'enableBYM',
          label: '开启主动群聊',
          bottomHelpMessage: '按概率参与群聊，固定使用 OpenAI-compatible API。',
          component: 'Switch'
        },
        {
          field: 'bymRate',
          label: '主动群聊触发概率',
          component: 'InputNumber',
          componentProps: { min: 0, max: 100 }
        },
        {
          field: 'debug',
          label: '调试日志',
          component: 'Switch'
        },
        {
          field: 'proxy',
          label: '代理服务器',
          component: 'Input'
        },
        {
          field: 'enableToolbox',
          label: '开启旧管理面板',
          bottomHelpMessage: '会增加资源占用，修改后需重启。',
          component: 'Switch'
        },
        {
          field: 'closeBrowserAfterRender',
          label: '图片渲染后关闭 Chromium',
          bottomHelpMessage: '降低图片渲染的常驻内存占用；独占浏览器会关闭，共享浏览器只断开连接。',
          component: 'Switch'
        },
        {
          label: 'OpenAI-compatible API',
          component: 'Divider'
        },
        {
          field: 'apiKey',
          label: 'API Key',
          component: 'InputPassword'
        },
        {
          field: 'openAiBaseUrl',
          label: 'API Base URL',
          bottomHelpMessage: '填写兼容 Chat Completions 的 /v1 地址。',
          component: 'Input'
        },
        {
          field: 'model',
          label: '模型',
          component: 'Input'
        },
        {
          field: 'apiStream',
          label: '流式响应',
          component: 'Switch'
        },
        {
          field: 'apiMaxToken',
          label: '最大输出 Token',
          component: 'InputNumber',
          componentProps: { min: 1 }
        },
        {
          field: 'apiThinkingMode',
          label: '思考模式',
          component: 'Select',
          componentProps: {
            options: [
              { label: '默认', value: 'default' },
              { label: '开启', value: 'enabled' },
              { label: '关闭', value: 'disabled' }
            ]
          }
        },
        {
          field: 'apiReasoningEffort',
          label: '思考强度',
          component: 'Select',
          componentProps: {
            options: [
              { label: '默认', value: 'default' },
              { label: 'high', value: 'high' },
              { label: 'max', value: 'max' }
            ]
          }
        },
        {
          field: 'promptPrefixOverride',
          label: '系统设定',
          component: 'InputTextArea'
        },
        {
          field: 'temperature',
          label: 'temperature',
          component: 'InputNumber',
          componentProps: { min: 0, max: 2 }
        },
        {
          field: 'forwardReasoning',
          label: '转发思考过程',
          component: 'Switch'
        },
        {
          field: 'smartMode',
          label: '开启工具调用',
          component: 'Switch'
        },
        {
          field: 'enableGroupContext',
          label: '读取群聊上下文',
          component: 'Switch'
        },
        {
          field: 'groupContextLength',
          label: '群聊上下文条数',
          component: 'InputNumber',
          componentProps: { min: 0 }
        },
        {
          field: 'groupMerge',
          label: '群会话合并',
          bottomHelpMessage: '开启后同群成员共享同一会话。',
          component: 'Switch'
        },
        {
          field: 'conversationPreserveTime',
          label: '会话保留秒数',
          component: 'InputNumber',
          componentProps: { min: 0 }
        },
        {
          label: '工具权限',
          component: 'Divider'
        },
        {
          field: 'enableToolPrivateSend',
          label: '允许工具发起私聊',
          component: 'Switch'
        },
        {
          field: 'enableToolCrossGroupSend',
          label: '允许工具跨群或跨用户发送',
          component: 'Switch'
        },
        {
          field: 'enableToolVideoDownload',
          label: '允许下载并发送视频',
          component: 'Switch'
        },
        {
          field: 'toolVideoMaxMB',
          label: '视频下载上限 MB',
          component: 'InputNumber',
          componentProps: { min: 1, max: 200 }
        },
        {
          field: 'amapKey',
          label: '高德地图 Key',
          component: 'InputPassword'
        },
        {
          field: 'azSerpKey',
          label: 'Azure Search Key',
          component: 'InputPassword'
        },
        {
          field: 'tavilyApiKey',
          label: 'Tavily Key',
          component: 'InputPassword'
        },
        {
          field: 'braveSearchApiKey',
          label: 'Brave Search Key',
          component: 'InputPassword'
        },
        {
          field: 'serpSource',
          label: '网页搜索来源',
          component: 'Select',
          componentProps: {
            options: [
              { label: 'Tavily', value: 'tavily' },
              { label: 'Azure Search', value: 'azure' },
              { label: '兼容公益源', value: 'ikechan8370' }
            ]
          }
        },
        {
          field: 'imageSearchSource',
          label: '图片搜索来源',
          component: 'Select',
          componentProps: {
            options: [
              { label: '自动', value: 'auto' },
              { label: 'Tavily', value: 'tavily' },
              { label: 'Brave', value: 'brave' },
              { label: '兼容公益源', value: 'ikechan8370' }
            ]
          }
        },
        {
          field: 'extraUrl',
          label: '额外工具服务地址',
          component: 'Input'
        },
        {
          field: 'githubAPIKey',
          label: 'GitHub Token',
          component: 'InputPassword'
        },
        {
          label: '回复与渲染',
          component: 'Divider'
        },
        {
          field: 'quoteReply',
          label: '引用回复',
          component: 'Switch'
        },
        {
          field: 'defaultUsePicture',
          label: '默认图片回复',
          component: 'Switch'
        },
        {
          field: 'autoUsePicture',
          label: '长回复自动转图片',
          component: 'Switch'
        },
        {
          field: 'autoUsePictureThreshold',
          label: '图片回复字数阈值',
          component: 'InputNumber',
          componentProps: { min: 1 }
        },
        {
          field: 'chromePath',
          label: 'Chromium 路径',
          component: 'Input'
        },
        {
          field: 'chromeTimeoutMS',
          label: 'Chromium 超时毫秒',
          component: 'InputNumber',
          componentProps: { min: 0 }
        },
        {
          field: 'chatViewWidth',
          label: '图片回复宽度',
          component: 'InputNumber',
          componentProps: { min: 320 }
        },
        {
          label: '语音',
          component: 'Divider'
        },
        {
          field: 'defaultUseTTS',
          label: '默认语音回复',
          component: 'Switch'
        },
        {
          field: 'alsoSendText',
          label: '语音同时发送文字',
          component: 'Switch'
        },
        {
          field: 'ttsMode',
          label: '语音来源',
          component: 'Select',
          componentProps: {
            options: [
              { label: 'VITS', value: 'vits-uma-genshin-honkai' },
              { label: '微软 Azure TTS', value: 'azure' },
              { label: 'VoiceVox', value: 'voicevox' }
            ]
          }
        },
        {
          field: 'defaultTTSRole',
          label: 'VITS 默认角色',
          component: 'Select',
          componentProps: {
            options: [{ label: '随机', value: '随机' }]
              .concat(speakers.map(name => ({ label: name, value: name })))
          }
        },
        {
          field: 'ttsSpace',
          label: 'VITS 服务地址',
          component: 'Input'
        },
        {
          field: 'voicevoxSpace',
          label: 'VoiceVox 服务地址',
          component: 'Input'
        },
        {
          field: 'voicevoxTTSSpeaker',
          label: 'VoiceVox 默认角色',
          component: 'Select',
          componentProps: {
            options: [{ label: '随机', value: '随机' }].concat(
              voxRoleList.flatMap(item => [
                ...item.styles.map(style => `${item.name}-${style.name}`),
                item.name
              ]).map(name => ({ label: name, value: name }))
            )
          }
        },
        {
          field: 'azureTTSKey',
          label: 'Azure TTS Key',
          component: 'InputPassword'
        },
        {
          field: 'azureTTSRegion',
          label: 'Azure TTS 区域',
          component: 'Input'
        },
        {
          field: 'azureTTSSpeaker',
          label: 'Azure TTS 默认角色',
          component: 'Select',
          componentProps: {
            options: [{ label: '随机', value: '随机' }].concat(
              azureRoleList.map(item => ({
                label: item.roleInfo || item.code,
                value: item.roleInfo || item.code
              }))
            )
          }
        },
        {
          field: 'azureTTSEmotion',
          label: 'Azure TTS 情绪',
          component: 'Switch'
        },
        {
          field: 'enhanceAzureTTSEmotion',
          label: '增强 Azure TTS 情绪提示',
          component: 'Switch'
        },
        {
          field: 'ttsAutoFallbackThreshold',
          label: '语音转文字阈值',
          component: 'InputNumber',
          componentProps: { min: 1 }
        },
        {
          field: 'cloudTranscode',
          label: '云端 Silk 转码地址',
          bottomHelpMessage: '留空时直接交给当前 QQ 适配器处理。',
          component: 'Input'
        }
      ],
      getConfigData () {
        return Config
      },
      setConfigData (data, { Result }) {
        for (let [keyPath, value] of Object.entries(data)) {
          if (['blockWords', 'promptBlockWords', 'initiativeChatGroups'].includes(keyPath)) {
            value = value.toString().split(/[,，;；|]/)
          }
          if (['blacklist', 'whitelist'].includes(keyPath)) {
            const regex = /^\^?[1-9]\d{5,9}(\^[1-9]\d{5,9})?$/
            const seen = new Set()
            value = value.toString().split(/[,，;；|\s]/).reduce((result, item) => {
              item = item.trim()
              if (!seen.has(item) && regex.test(item)) {
                seen.add(item)
                result.push(item)
              }
              return result
            }, [])
          }
          if (Config[keyPath] !== value) {
            Config[keyPath] = value
          }
        }

        const azureSpeaker = azureRoleList.find(item =>
          (item.roleInfo || item.code) === data.azureTTSSpeaker
        )
        if (azureSpeaker) {
          Config.azureTTSSpeaker = azureSpeaker.code
        }
        return Result.ok({}, '保存成功~')
      }
    }
  }
}
