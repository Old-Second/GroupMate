import { Config } from './utils/config.js'
import { speakers } from './utils/tts.js'
import { supportConfigurations as azureRoleList } from './utils/tts/microsoft-azure.js'
import { supportConfigurations as voxRoleList } from './utils/tts/voicevox.js'
import { normalizeGuobaConfigValue } from './dist/runtime/guoba-config.js'
import { buildGuobaSchemas } from './dist/runtime/guoba-schema.js'
import { createPendingIndicatorConfigPort } from './dist/runtime/presentation/pending-indicator-config.js'
import { pluginId, repositoryUrl } from './dist/runtime/plugin-context.js'
import { updateProductionObservabilityLevel } from './dist/runtime/production-yunzai-agent.js'

const pendingIndicatorConfig = createPendingIndicatorConfigPort(redis)
const RESTART_REQUIRED_CONFIG_FIELDS = new Set([
  'toggleMode',
  'apiKey',
  'openAiBaseUrl',
  'openAiCompatibilityProfile',
  'proxy',
  'headless',
  'chromePath'
])

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
      async getConfigData () {
        return {
          ...Config,
          turnConfirm: await pendingIndicatorConfig.getEnabled()
        }
      },
      async setConfigData (data, { Result }) {
        // 先完成全部校验，避免无效枚举导致配置只保存一半。
        const normalized = Object.entries(data).map(([keyPath, rawValue]) => [
          keyPath,
          normalizeGuobaConfigValue(keyPath, rawValue)
        ])
        let restartRequired = false
        let observabilityResult = null
        for (const [keyPath, value] of normalized) {
          if (keyPath === 'turnConfirm') {
            await pendingIndicatorConfig.setEnabled(value)
            continue
          }
          if (keyPath === 'observabilityLevel') {
            if (value === 'off') {
              Config.observabilityLevel = 'off'
              observabilityResult = await updateProductionObservabilityLevel('off')
            } else {
              observabilityResult = await updateProductionObservabilityLevel(value)
              if (observabilityResult.kind === 'applied') {
                Config.observabilityLevel = value
              }
            }
            continue
          }
          if (Config[keyPath] !== value) {
            if (RESTART_REQUIRED_CONFIG_FIELDS.has(keyPath)) restartRequired = true
            Config[keyPath] = value
          }
        }

        const azureSpeaker = azureRoleList.find(item =>
          (item.roleInfo || item.code) === data.azureTTSSpeaker
        )
        if (azureSpeaker) {
          Config.azureTTSSpeaker = azureSpeaker.code
        }
        const observabilityMessage = observabilityResult?.kind === 'barrier_pending'
          ? '可观测性已保持关闭；轨迹清理仍在进行，完成前无法重新开启。'
          : observabilityResult?.kind === 'barrier_failed'
            ? '可观测性已保持关闭；轨迹清理失败，请再次保存“完全关闭”后重试。'
            : null
        return Result.ok({}, observabilityMessage ?? (restartRequired
          ? '保存成功；部分模型传输、运行入口或 Chromium 配置将在重启后生效~'
          : '保存成功~'))
      }
    }
  }
}
