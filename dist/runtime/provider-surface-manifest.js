export const providerSurfaceIds = [
    'openaiCompatible',
    'chatgptWeb',
    'bing',
    'claude',
    'gemini',
    'qwen',
    'chatglm',
    'xinghuo',
    'azureOpenai'
];
export const providerSurfaceManifest = {
    sources: {
        openaiCompatible: [
            'utils/openai/chatgpt-api.js',
            'utils/openai/fetch-sse.js',
            'utils/chat.js',
            'utils/randomMessage.js',
            'utils/translate.js',
            'model/core.js'
        ],
        chatgptWeb: [
            'utils/message.js',
            'apps/chat.js',
            'model/core.js'
        ],
        bing: [
            'utils/SydneyAIClient.js',
            'client/CopilotAIClient.js',
            'utils/BingDraw.js',
            'apps/draw.js'
        ],
        claude: [
            'client/ClaudeAPIClient.js',
            'utils/claude.ai/index.js'
        ],
        gemini: [
            'client/CustomGoogleGeminiClient.js',
            'client/GoogleGeminiClient.js',
            'patches/@google__generative-ai@0.1.1.patch'
        ],
        qwen: [
            'utils/alibaba/qwen-api.js',
            'utils/alibaba/tokenizer.js',
            'utils/alibaba/types.js'
        ],
        chatglm: [
            'client/ChatGLM4Client.js',
            'utils/chatglm.js'
        ],
        xinghuo: [
            'utils/xinghuo/xinghuo.js',
            'apps/chat.js',
            'utils/translate.js'
        ],
        azureOpenai: [
            'model/core.js',
            'apps/chat.js'
        ]
    },
    commands: {
        openaiCompatible: ['#chat1', '#chatgpt切换API'],
        chatgptWeb: ['#chat3', '#api3', '#chatgpt切换API3'],
        bing: ['#bing', '#chatgpt切换必应', '#chatgpt切换Copilot'],
        claude: ['#claude', '#claude.ai', '#chatgpt切换Claude'],
        gemini: ['#gemini', '#chatgpt切换Gemini'],
        qwen: ['#qwen', '#chatgpt切换通义千问'],
        chatglm: ['#chatglm', '#glm4', '#chatgpt切换ChatGLM4'],
        xinghuo: ['#xh', '#星火', '#chatgpt切换星火'],
        azureOpenai: ['#chatgpt切换azure']
    },
    configFields: {
        openaiCompatible: [
            'apiKey',
            'openAiBaseUrl',
            'model',
            'apiStream',
            'apiThinkingMode',
            'apiReasoningEffort'
        ],
        chatgptWeb: [
            'OpenAiPlatformRefreshToken',
            'api',
            'apiBaseUrl',
            'apiForceUseReverse',
            'useGPT4'
        ],
        bing: [
            'sydney',
            'sydneyReverseProxy',
            'sydneyForceUseReverse',
            'sydneyWebsocketUseProxy',
            'sydneyMood',
            'sydneyMoodTip',
            'sydneyEnableSearch',
            'sydneyFirstMessageTimeout',
            'sydneyApologyIgnored',
            'bingAiToken',
            'bingAiClientId',
            'bingAiScope',
            'bingAiRefreshToken',
            'bingAiOid',
            'bingReasoning'
        ],
        claude: [
            'claudeApiKey',
            'claudeApiBaseUrl',
            'claudeApiModel',
            'claudeSystemPrompt',
            'claudeAIOrganizationId',
            'claudeAISessionKey',
            'claudeAIReverseProxy',
            'claudeAITimeout',
            'claudeAIJA3',
            'claudeAIUA'
        ],
        gemini: [
            'geminiKey',
            'geminiModel',
            'geminiPrompt',
            'geminiBaseUrl',
            'geminiEnableGoogleSearch',
            'geminiEnableCodeExecution',
            'geminiForceToolKeywords'
        ],
        qwen: [
            'qwenApiKey',
            'qwenModel',
            'qwenTopP',
            'qwenTopK',
            'qwenSeed',
            'qwenTemperature',
            'qwenEnableSearch'
        ],
        chatglm: ['chatglmBaseUrl', 'chatglmRefreshToken'],
        xinghuo: [
            'xinghuoToken',
            'xhmode',
            'xhAppId',
            'xhAPISecret',
            'xhAPIKey',
            'xhAssistants',
            'xhTemperature',
            'xhMaxTokens',
            'xhPromptSerialize',
            'xhPrompt',
            'xhPromptEval',
            'xhRetRegExp',
            'xhRetReplace'
        ],
        azureOpenai: ['azureUrl', 'azureDeploymentName']
    },
    uiFields: {
        openaiCompatible: ['apiKey', 'openAiBaseUrl', 'model'],
        chatgptWeb: ['api', 'apiBaseUrl', 'OpenAiPlatformRefreshToken'],
        bing: ['sydney', 'sydneyReverseProxy', 'bingAiToken'],
        claude: ['claudeApiKey', 'claudeAISessionKey'],
        gemini: ['geminiKey', 'geminiModel', 'geminiBaseUrl'],
        qwen: ['qwenApiKey', 'qwenModel'],
        chatglm: ['chatglmBaseUrl', 'chatglmRefreshToken'],
        xinghuo: ['xinghuoToken', 'xhmode', 'xhAPIKey'],
        azureOpenai: ['azureUrl', 'azureDeploymentName']
    },
    dependencies: {
        openaiCompatible: ['eventsource', 'eventsource-parser'],
        chatgptWeb: [],
        bing: [],
        claude: ['cycletls'],
        gemini: ['@google/generative-ai'],
        qwen: [],
        chatglm: [],
        xinghuo: [],
        azureOpenai: ['@azure/openai']
    },
    lexicalMarkers: {
        openaiCompatible: ['ChatGPTAPI', 'chat/completions', 'openAiBaseUrl'],
        chatgptWeb: ['OfficialChatGPTClient', 'api3', 'defaultChatGPTAPI', 'OpenAiPlatformRefreshToken'],
        bing: ['SydneyAIClient', 'BingAIClient', 'CopilotAIClient', 'sydneyReverseProxy', 'bingAiToken', '#bing'],
        claude: ['ClaudeAPIClient', 'ClaudeAIClient', 'claudeApiKey', 'claudeAISessionKey', '#claude'],
        gemini: ['GeminiClient', 'geminiKey', '@google/generative-ai', '#gemini'],
        qwen: ['QwenApi', 'qwenApiKey', '#qwen', '通义千问'],
        chatglm: ['ChatGLM4Client', 'chatglmBaseUrl', 'chatglmRefreshToken', '#chatglm', '#glm4'],
        xinghuo: ['XinghuoClient', 'xinghuoToken', 'xhAPIKey', '#星火'],
        azureOpenai: ['azureUrl', 'azureDeploymentName', '@azure/openai', 'useAzureBasedSolution']
    },
    preservedExclusions: {
        directories: ['server/static/', 'docs/', 'test/', '.test-dist/'],
        files: ['AGENTS.md', 'NOTICE.md'],
        paths: [
            'src/runtime/provider-surface-manifest.ts',
            'dist/runtime/provider-surface-manifest.js',
            'utils/tts/microsoft-azure.js',
            'utils/tts.js',
            'utils/tools/SerpTool.js',
            'utils/tools/SerpIkechan8370Tool.js',
            'utils/tools/SearchImageTool.js'
        ],
        identifiers: [
            'azureTTSKey',
            'azureTTSRegion',
            'azureTTSSpeaker',
            'azureTTSEmotion',
            'enhanceAzureTTSEmotion'
        ],
        dependencies: [
            'eventsource',
            'eventsource-parser',
            'microsoft-cognitiveservices-speech-sdk'
        ]
    }
};
