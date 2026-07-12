import plugin from '../../../lib/plugins/plugin.js'
import { Config } from '../utils/config.js'
import { render } from '../utils/common.js'
import { pluginDirectoryName } from '../dist/runtime/plugin-context.js'

const helpData = [
  {
    group: '聊天',
    list: [
      {
        icon: 'chat',
        title: Config.toggleMode === 'at' ? '@我+聊天内容' : '#chat+聊天内容',
        desc: '使用 OpenAI-compatible API 与 GroupMate 聊天'
      },
      {
        icon: 'chat',
        title: '#chat1+聊天内容',
        desc: '显式使用当前 OpenAI-compatible API'
      },
      {
        icon: 'chat-private',
        title: '私聊与我对话',
        desc: '开启私聊后可直接聊天'
      },
      {
        icon: 'destroy',
        title: '#(结束|新开|摧毁|毁灭|完结)对话',
        desc: '结束当前会话'
      },
      {
        icon: 'destroy-other',
        title: '#(结束|新开|摧毁|毁灭|完结)对话 @某人',
        desc: '结束指定群友的当前会话'
      }
    ]
  },
  {
    group: '回复',
    list: [
      {
        icon: 'picture',
        title: '#chatgpt图片模式',
        desc: '使用图片呈现回复'
      },
      {
        icon: 'text',
        title: '#chatgpt文本模式',
        desc: '使用文本呈现回复'
      },
      {
        icon: 'sound',
        title: '#chatgpt语音模式',
        desc: '使用语音呈现回复'
      },
      {
        icon: 'game',
        title: '#chatgpt设置语音角色',
        desc: '设置当前语音角色'
      }
    ]
  },
  {
    group: '管理',
    list: [
      {
        icon: 'blue',
        title: '#chatgpt(本群)?(群xxx)?闭嘴(x秒/分钟/小时)',
        desc: '暂停全局、当前群或指定群回复'
      },
      {
        icon: 'eye',
        title: '#chatgpt(本群)?(群xxx)?(张嘴|开口|说话|上班)',
        desc: '恢复回复'
      },
      {
        icon: 'confirm',
        title: '#chatgpt开启/关闭问题确认',
        desc: '设置收到消息后的确认提示'
      },
      {
        icon: 'list',
        title: '#(关闭|打开)群聊上下文',
        desc: '设置是否读取近期群聊'
      },
      {
        icon: 'switch',
        title: '#chatgpt(允许|禁止|打开|关闭|同意)私聊',
        desc: '设置私聊通道'
      }
    ]
  },
  {
    group: '配置',
    list: [
      {
        icon: 'key',
        title: '#chatgpt设置APIKey',
        desc: '设置 OpenAI-compatible API Key'
      },
      {
        icon: 'key',
        title: '#chatgpt设置API模型',
        desc: '设置模型'
      },
      {
        icon: 'key',
        title: '#chatgpt设置API反代',
        desc: '设置 API Base URL'
      },
      {
        icon: 'token',
        title: '#chatgpt(开启|关闭)智能模式',
        desc: '开关工具调用'
      },
      {
        icon: 'eat',
        title: '#chatgpt设置API设定',
        desc: '设置系统设定'
      }
    ]
  },
  {
    group: '设定',
    list: [
      {
        icon: 'smiley-wink',
        title: '#chatgpt设定列表',
        desc: '查看所有设定'
      },
      {
        icon: 'eat',
        title: '#chatgpt查看设定【设定名】',
        desc: '查看指定设定'
      },
      {
        icon: 'coin',
        title: '#chatgpt添加设定',
        desc: '添加或覆盖设定'
      },
      {
        icon: 'switch',
        title: '#chatgpt使用设定【设定名】',
        desc: '应用到 OpenAI-compatible API'
      }
    ]
  }
]

export class help extends plugin {
  constructor () {
    super({
      name: 'ChatGPT-Plugin 帮助',
      dsc: 'GroupMate 帮助面板',
      event: 'message',
      priority: 500,
      rule: [
        {
          reg: '^#(chatgpt|ChatGPT)(命令|帮助|菜单|help|说明|功能|指令|使用说明)$',
          fnc: 'help'
        }
      ]
    })
  }

  async help (e) {
    await render(e, pluginDirectoryName, 'help/index', {
      helpData,
      version: Config.version
    })
  }
}
