import { Config } from './utils/config.js'
import { speakers } from './utils/tts.js'
import { supportConfigurations as azureRoleList } from './utils/tts/microsoft-azure.js'
import { supportConfigurations as voxRoleList } from './utils/tts/voicevox.js'
import { normalizeGuobaConfigValue } from './dist/runtime/guoba-config.js'
import { buildGuobaSchemas } from './dist/runtime/guoba-schema.js'
import { pluginId, repositoryUrl } from './dist/runtime/plugin-context.js'

function roleOption (name) {
  return { label: name, value: name }
}

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
      schemas: buildGuobaSchemas({
        vitsRoleOptions: [roleOption('随机')].concat(speakers.map(roleOption)),
        voicevoxRoleOptions: [roleOption('随机')].concat(
          voxRoleList.flatMap(item => [
            ...item.styles.map(style => `${item.name}-${style.name}`),
            item.name
          ]).map(roleOption)
        ),
        azureRoleOptions: [roleOption('随机')].concat(
          azureRoleList.map(item => roleOption(item.roleInfo || item.code))
        )
      }),
      getConfigData () {
        return Config
      },
      setConfigData (data, { Result }) {
        for (const [keyPath, rawValue] of Object.entries(data)) {
          const value = normalizeGuobaConfigValue(keyPath, rawValue)
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
