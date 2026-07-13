export interface GuobaSelectOption {
  label: string
  value: string
}

export interface GuobaSchema {
  field?: string
  label: string
  bottomHelpMessage?: string
  component: string
  componentProps?: Record<string, unknown>
}

interface BuildGuobaSchemasOptions {
  vitsRoleOptions: GuobaSelectOption[]
  voicevoxRoleOptions: GuobaSelectOption[]
  azureRoleOptions: GuobaSelectOption[]
}

function divider (label: string): GuobaSchema {
  return { label, component: 'Divider' }
}

function field (
  name: string,
  label: string,
  bottomHelpMessage: string,
  component = 'Input',
  componentProps?: Record<string, unknown>
): GuobaSchema {
  return {
    field: name,
    label,
    bottomHelpMessage,
    component,
    ...(componentProps ? { componentProps } : {})
  }
}

const thinkingModeOptions = [
  { label: '默认', value: 'default' },
  { label: '开启', value: 'enabled' },
  { label: '关闭', value: 'disabled' }
]

const reasoningEffortOptions = [
  { label: '默认', value: 'default' },
  { label: 'high', value: 'high' },
  { label: 'max', value: 'max' }
]

export function buildGuobaSchemas ({
  vitsRoleOptions,
  voicevoxRoleOptions,
  azureRoleOptions
}: BuildGuobaSchemasOptions): GuobaSchema[] {
  return [
    divider('基础与运行'),
    field('toggleMode', '触发方式', 'at 模式仅在机器人被提及时回复；前缀模式使用 #chat 触发。', 'Select', {
      options: [
        { label: 'at', value: 'at' },
        { label: '#chat', value: 'prefix' }
      ]
    }),
    field('assistantLabel', '群内名字', '模型使用的自称，也用于主动群聊判断是否有人点名机器人。'),
    field('enablePrivateChat', '允许私聊', '开启后允许用户在 QQ 私聊中触发普通对话。', 'Switch'),
    field('enableRobotAt', '允许真实 @ 群友', '开启后，回复文本中的群成员提及会转换成真正的 QQ @。', 'Switch'),
    field('proxy', '代理服务器', '供网络请求和 Chromium 使用的 HTTP 或 SOCKS5 代理地址；修改后建议重启。'),
    field('defaultTimeoutMs', '默认请求超时毫秒', 'OpenAI-compatible 等普通网络请求的默认超时时间。', 'InputNumber', { min: 1 }),
    field('debug', '调试日志', '输出脱敏的请求、响应和工具元数据；排障时开启，日常运行可关闭。', 'Switch'),

    divider('模型与会话'),
    field('apiKey', 'API Key', 'OpenAI-compatible Chat Completions 服务的访问密钥，只会保存到本机真实配置。', 'InputPassword'),
    field('openAiBaseUrl', 'API Base URL', '填写兼容 Chat Completions 的 /v1 地址，例如 https://api.example.com/v1。'),
    field('model', '模型', '填写服务端实际支持的模型 ID，例如 deepseek-chat；留空时使用适配器默认值。'),
    field('promptPrefixOverride', '系统设定', '普通对话使用的系统设定，用于定义身份、语气和回答边界。', 'InputTextArea'),
    field('temperature', '生成温度', '控制普通回复的随机性；服务端不支持时可能忽略该参数。', 'InputNumber', { min: 0, max: 2, step: 0.1 }),
    field('apiStream', '流式响应', '开启 Chat Completions 流式传输；最终 QQ 回复仍由统一展示层发送。', 'Switch'),
    field('apiMaxToken', '最大输出 Token', '单次模型回复允许使用的最大输出 Token 数。', 'InputNumber', { min: 1 }),
    field('apiThinkingMode', '思考模式', '向支持该扩展的 OpenAI-compatible 服务传递 thinking.type；默认表示不显式传参。', 'Select', { options: thinkingModeOptions }),
    field('apiReasoningEffort', '思考强度', '向支持该扩展的模型传递 reasoning_effort；默认表示由服务端决定。', 'Select', { options: reasoningEffortOptions }),
    field('forwardReasoning', '转发思考过程', '将兼容服务返回的 reasoning_content 以转发消息展示；可能增加消息数量并暴露模型推理文本。', 'Switch'),
    field('openAiForceUseReverse', '强制保留自定义 API 地址', '开启后即使设置了代理或环境可直连，也始终使用上方自定义 API Base URL。', 'Switch'),
    field('enableGroupContext', '读取群聊上下文', '将近期群聊记录加入模型上下文；会增加 Token 消耗并向模型服务发送相关消息内容。', 'Switch'),
    field('groupContextLength', '群聊上下文条数', '最多读取的近期群消息数量；越大越消耗 Token。', 'InputNumber', { min: 0 }),
    field('groupContextTip', '群聊上下文提示词', '读取群聊记录时附加给模型的说明，用于强调身份区分和上下文使用方式。', 'InputTextArea'),
    field('groupMerge', '群会话合并', '开启后同一群成员共享模型会话；关闭后按群和用户隔离。', 'Switch'),
    field('conversationPreserveTime', '会话保留秒数', 'Redis 会话过期时间；大于 0 时按秒过期，0 表示不设置自动过期。', 'InputNumber', { min: 0 }),

    divider('群聊参与'),
    field('initiativeChatGroups', '定时主动聊天群', '定时发送主动话题的群号列表，使用逗号、分号、竖线或空格分隔。'),
    field('helloProbability', '主动聊天触发概率', '每次定时任务实际发送主动消息的概率，单位为百分比。', 'InputNumber', { min: 0, max: 100 }),
    field('helloInterval', '主动聊天间隔小时', '定时任务在 7:00 到 23:00 之间使用的小时步长；修改后需重启以重建任务。', 'InputNumber', { min: 1, max: 24 }),
    field('helloPrompt', '主动打招呼提示词', '定时主动聊天时用于生成短消息的提示词。', 'InputTextArea'),
    field('enableBYM', '开启随机参与群聊', '按概率观察普通群消息并自然参与，固定使用当前 OpenAI-compatible API。', 'Switch'),
    field('bymRate', '随机参与触发概率', '每条符合条件的群消息触发随机参与的概率，单位为百分比。', 'InputNumber', { min: 0, max: 100 }),
    field('bymDisableGroup', '随机参与禁用群', '这些群不会触发随机参与；输入群号标签。', 'GTags', { allowAdd: true, closable: true }),
    field('bymThinkingMode', '随机参与思考模式', '随机参与请求单独使用的 thinking.type；默认表示不显式传参。', 'Select', { options: thinkingModeOptions }),
    field('bymReasoningEffort', '随机参与思考强度', '随机参与请求单独使用的 reasoning_effort；默认表示由服务端决定。', 'Select', { options: reasoningEffortOptions }),
    field('bymPreset', '随机参与额外设定', '附加到随机参与系统提示后的角色或群聊风格设定。', 'InputTextArea'),
    field('bymFuckList', '反击触发词', '命中任一词时启用反击设定；使用标签或分隔符输入。', 'GTags', { allowAdd: true, closable: true }),
    field('bymFuckBlacklist', '反击豁免 QQ', '这些 QQ 号不会触发反击，但仍可触发普通随机参与。', 'GTags', { allowAdd: true, closable: true }),
    field('bymFuckPrompt', '反击行为设定', '命中反击触发词时附加的系统设定；内容会直接影响模型语气。', 'InputTextArea'),
    field('bymFuckRecall', '自动撤回反击回复', '开启后只撤回随机参与产生的反击回复，不撤回用户消息或普通错误提示。', 'Switch'),
    field('bymFuckRecallTime', '反击回复撤回秒数', '反击回复成功发送后等待多少秒撤回。', 'InputNumber', { min: 1, max: 3600 }),

    divider('工具与搜索'),
    field('smartMode', '开启工具调用', '允许模型使用搜索、图片、语音和授权群管理工具，会增加请求次数；权限仍由运行时校验。', 'Switch'),
    field('toolPolicyProfile', '工具权限策略', '兼容模式仅执行运行时权限校验；安全模式会审批跨会话发送、踢人、消息管理和操作他人；严格模式会审批所有可见输出和副作用工具。', 'Select', {
      options: [
        { label: '兼容', value: 'compatible' },
        { label: '安全', value: 'safe' },
        { label: '严格', value: 'strict' }
      ]
    }),
    field('toolApprovalTtlSeconds', '审批有效秒数', '工具审批口令的有效时间，范围 30 到 300 秒；过期后必须重新发起。', 'InputNumber', { min: 30, max: 300 }),
    field('enableToolPrivateSend', '允许工具发起私聊', '允许机器人主人通过工具向明确指定的 QQ 用户发起私聊；关闭时即使主人也不能通过工具发送。', 'Switch'),
    field('enableToolCrossGroupSend', '允许工具跨群发送', '允许机器人主人通过工具向明确指定的其他群发送消息；关闭时即使主人也不能跨群发送。', 'Switch'),
    field('enableToolVideoDownload', '允许下载并发送视频', '开启后视频工具可以下载并上传文件；关闭时只发送信息和链接。', 'Switch'),
    field('toolVideoMaxMB', '视频下载上限 MB', '视频工具允许下载的单文件大小上限；当前为保护低内存部署机，硬上限为 8 MB。', 'InputNumber', { min: 1, max: 8 }),
    field('serpSource', '网页搜索来源', 'Bing Web Search 已退役，推荐使用 Tavily；兼容公益源不保证可用性和长期维护。', 'Select', {
      options: [
        { label: 'Tavily', value: 'tavily' },
        { label: 'Bing Web Search（已退役）', value: 'azure' },
        { label: '兼容公益源', value: 'ikechan8370' }
      ]
    }),
    field('tavilyApiKey', 'Tavily API Key', '用于网页搜索和图片搜索。获取或管理 Key：https://app.tavily.com/home', 'InputPassword'),
    field('azSerpKey', 'Bing Web Search Key（已退役）', '仅兼容旧配置；Bing Search API 已于 2025-08-11 退役，无法新申请，建议改用 Tavily。微软公告：https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement', 'InputPassword'),
    field('imageSearchSource', '图片搜索来源', '选择图片搜索工具使用的后端；自动模式会按已配置密钥选择。', 'Select', {
      options: [
        { label: '自动', value: 'auto' },
        { label: 'Tavily', value: 'tavily' },
        { label: 'Brave', value: 'brave' },
        { label: '兼容公益源', value: 'ikechan8370' }
      ]
    }),
    field('braveSearchApiKey', 'Brave Search API Key', '用于图片搜索。获取或管理 Key：https://api-dashboard.search.brave.com/app/keys', 'InputPassword'),
    field('amapKey', '高德地图 Key', '用于地图和天气工具，请创建“Web 服务”类型 Key：https://lbs.amap.com/api/webservice/guide/create-project/get-key', 'InputPassword'),
    field('githubAPIKey', 'GitHub Token', '可选，用于提高 GitHub 工具的 API 限额；请生成最小权限、设置有效期的 Token：https://github.com/settings/personal-access-tokens', 'InputPassword'),
    field('extraUrl', '额外工具服务地址', 'OCR、图片处理等扩展工具使用的兼容服务根地址，需自行部署；搭建参考：https://github.com/ikechan8370/chatgpt-plugin-extras'),

    divider('权限与内容安全'),
    field('whitelist', '对话白名单', '支持群号、^QQ号或群号^QQ号；存在白名单时，只有匹配项可以使用普通对话。'),
    field('blacklist', '对话黑名单', '格式与白名单相同；白名单匹配优先于黑名单。'),
    field('promptBlockWords', '输入屏蔽词', '用户输入包含任一词时拒绝请求；使用逗号、分号或竖线分隔，短语中的空格会保留。', 'InputTextArea'),
    field('blockWords', '输出屏蔽词', '模型回复包含任一词时不发送；使用逗号、分号或竖线分隔，短语中的空格会保留。', 'InputTextArea'),
    field('imgOcr', '聊天图片 OCR', '普通对话同时包含图片时，尝试读取图片文字并加入模型输入。', 'Switch'),

    divider('回复与图片'),
    field('quoteReply', '引用触发消息', '回复时引用用户原消息；最终表现取决于当前 QQ 适配器和消息类型。', 'Switch'),
    field('defaultUsePicture', '默认图片回复', '将普通模型回复默认渲染成图片发送。', 'Switch'),
    field('autoUsePicture', '长回复自动转图片', '文字超过阈值时自动改用图片回复。', 'Switch'),
    field('autoUsePictureThreshold', '图片回复字数阈值', '开启长回复自动转图片后，达到该字符数触发图片渲染。', 'InputNumber', { min: 1 }),
    field('chatViewWidth', '图片回复宽度', '聊天回复图片的渲染视口宽度。', 'InputNumber', { min: 320 }),
    field('toneStyle', '图片回复风格', '传递给聊天图片模板的风格名称；模板不支持时保持默认效果。'),
    field('chatViewBotName', '图片中的机器人名称', '覆盖聊天图片模板显示的机器人名称；留空时使用当前 Bot 名称。'),
    field('cloudDPR', '图片渲染 DPR', '图片渲染设备像素比；数值越高越清晰，也越消耗内存。', 'InputNumber', { min: 0.5, max: 4, step: 0.1 }),
    field('closeBrowserAfterRender', '图片渲染后释放 Chromium', '降低常驻内存；独占浏览器会关闭，共享浏览器只断开连接，下一次渲染会稍慢。', 'Switch'),
    field('headless', 'Chromium 无头模式', '控制插件自启 Chromium 时是否使用无头模式；连接共享浏览器时可能不生效。', 'Switch'),
    field('chromePath', 'Chromium 路径', '留空时使用 Puppeteer 默认 Chromium；填写可执行文件绝对路径可指定本机浏览器。'),
    field('chromeTimeoutMS', 'Chromium 超时毫秒', '页面加载和图片渲染使用的浏览器超时时间。', 'InputNumber', { min: 1 }),

    divider('渲染服务与外观'),
    field('viewHost', '独立渲染服务地址', '可选的完整渲染服务 URL；填写后聊天图片缓存和页面请求会发往该地址。'),
    field('cloudRender', '公开本机渲染资源', '将本机渲染地址替换为外部可访问地址；需要正确配置端口、防火墙和 serverHost。', 'Switch'),
    field('serverHost', '本机服务外部主机', '旧管理和云渲染对外访问的 host[:port]，不要填写 http:// 前缀。'),
    field('serverPort', '旧管理与渲染服务端口', 'Fastify 旧管理和本地渲染服务监听端口；修改后需重启。', 'InputNumber', { min: 1, max: 65535 }),
    field('showQRCode', '图片显示访问二维码', '在渲染图片中加入缓存页面二维码；二维码可能让持有者访问对应的渲染内容。', 'Switch'),
    field('enableToolbox', '开启旧管理面板', '启动 Fastify 旧管理面板，会增加端口、文件监听和内存占用；修改后需重启。', 'Switch'),
    field('groupAdminPage', '允许群内获取旧面板地址', '开启后可在群聊中获取旧管理面板地址；关闭时仅允许私聊获取。', 'Switch'),
    field('live2d', '图片显示 Live2D', '在支持的本地聊天图片模板中启用 Live2D，可能显著增加渲染资源消耗。', 'Switch'),
    field('live2dModel', 'Live2D 模型路径', '相对于旧管理面板静态资源的 Live2D model3.json 路径。'),
    field('live2dOption_scale', 'Live2D 缩放', '聊天图片中 Live2D 模型的缩放比例。', 'InputNumber', { min: 0 }),
    field('live2dOption_positionX', 'Live2D 横向位置', '聊天图片中 Live2D 模型的横向偏移。', 'InputNumber'),
    field('live2dOption_positionY', 'Live2D 纵向位置', '聊天图片中 Live2D 模型的纵向偏移。', 'InputNumber'),
    field('live2dOption_rotation', 'Live2D 旋转角度', '聊天图片中 Live2D 模型的旋转角度。', 'InputNumber'),
    field('live2dOption_alpha', 'Live2D 透明度', '聊天图片中 Live2D 模型的透明度，范围 0 到 1。', 'InputNumber', { min: 0, max: 1, step: 0.1 }),

    divider('语音回复'),
    field('defaultUseTTS', '默认语音回复', '将普通模型回复默认转换为语音；可通过聊天命令临时切换。', 'Switch'),
    field('alsoSendText', '语音同时发送文字', '语音回复之外同时发送文字内容，便于音质不佳时阅读。', 'Switch'),
    field('ttsMode', '语音来源', '选择 VITS、Microsoft Azure TTS 或 VoiceVox 作为语音合成后端。', 'Select', {
      options: [
        { label: 'VITS', value: 'vits-uma-genshin-honkai' },
        { label: '微软 Azure TTS', value: 'azure' },
        { label: 'VoiceVox', value: 'voicevox' }
      ]
    }),
    field('ttsRegex', '语音过滤正则', '语音合成前移除匹配内容，格式为 /表达式/标志；无效表达式会按不过滤处理。'),
    field('ttsAutoFallbackThreshold', '语音转文字阈值', '回复超过该字符数时跳过语音生成并回退为文字，避免长音频和高资源占用。', 'InputNumber', { min: 1 }),
    field('cloudTranscode', '云端 Silk 转码地址', '可选的自建 Silk 转码服务；留空时直接交给当前 QQ 适配器处理。'),
    field('cloudMode', '云端转码传输模式', '远程 URL 使用链接模式；本地文件或不能被转码服务访问的音频使用文件模式。', 'Select', {
      options: [
        { label: '链接', value: 'url' },
        { label: '文件', value: 'file' }
      ]
    }),
    field('defaultTTSRole', 'VITS 默认角色', 'VITS 语音回复默认使用的角色；随机会在当前角色列表中选择。', 'Select', { options: vitsRoleOptions }),
    field('ttsSpace', 'VITS 服务地址', '填写 VITS Gradio 兼容服务根地址，不要附加 /api/generate；可复制示例 Space 后查看自己的 API 地址：https://huggingface.co/spaces/ikechan8370/vits-uma-genshin-honkai'),
    field('huggingFaceReverseProxy', 'VITS Hugging Face 反代', '可选的 Hugging Face Space 请求和文件下载反代地址；没有自建反代时留空。'),
    field('autoJapanese', 'VITS 自动日语', '使用 VITS 时先把回复转换为日语再合成；会增加一次翻译请求。', 'Switch'),
    field('noiseScale', 'VITS 情感变化', 'VITS noise_scale 参数，数值越大情感变化通常越明显。', 'InputNumber', { min: 0, max: 1, step: 0.01 }),
    field('noiseScaleW', 'VITS 音素长度变化', 'VITS noise_scale_w 参数，用于控制音素时长变化。', 'InputNumber', { min: 0, max: 1, step: 0.01 }),
    field('lengthScale', 'VITS 语速', 'VITS length_scale 参数；通常越大语速越慢。', 'InputNumber', { min: 0.1, max: 2, step: 0.1 }),
    field('voicevoxSpace', 'VoiceVox 服务地址', '填写可访问的 VOICEVOX Engine HTTP 根地址，例如 http://127.0.0.1:50021；自建参考：https://github.com/VOICEVOX/voicevox_engine'),
    field('voicevoxTTSSpeaker', 'VoiceVox 默认角色', 'VoiceVox 语音回复默认使用的角色和风格。', 'Select', { options: voicevoxRoleOptions }),
    field('azureTTSKey', 'Azure TTS Key', '在 Azure 门户创建 Speech 服务后填写 Key，并同步配置下方区域：https://portal.azure.com/；该密钥只用于语音合成，不属于模型 Provider。', 'InputPassword'),
    field('azureTTSRegion', 'Azure TTS 区域', 'Microsoft Speech 资源所在区域，例如 eastasia。'),
    field('azureTTSSpeaker', 'Azure TTS 默认角色', 'Azure TTS 默认使用的语音角色。', 'Select', { options: azureRoleOptions }),
    field('azureTTSEmotion', 'Azure TTS 情绪', '根据模型输出的情绪标记选择 Azure TTS 说话风格。', 'Switch'),
    field('enhanceAzureTTSEmotion', '增强 Azure TTS 情绪提示', '在系统提示中要求模型输出 Azure TTS 情绪标记；会改变模型回复格式。', 'Switch'),

    divider('表情与音乐'),
    field('emojiBaseURL', 'Emoji Kitchen 服务地址', '两个 Emoji 合成图片时使用的兼容服务根地址。'),
    field('sunoSessToken', 'Suno Session Token', '音乐合成功能使用的 Session Token；多个账号按相同顺序用逗号分隔。', 'InputPassword'),
    field('sunoClientToken', 'Suno Client Token', '与 Session Token 一一对应的 Client Token；只保存到本机真实配置。', 'InputPassword'),
    field('enableChatSuno', '对话生成 Suno 结构', '要求普通聊天在创作歌曲时输出 Suno 可消费的结构化歌词；只影响提示词。', 'Switch')
  ]
}
