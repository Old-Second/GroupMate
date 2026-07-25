import { Config, supportedConfigKeys } from './utils/config.js'
import { speakers } from './utils/tts.js'
import { supportConfigurations as azureRoleList } from './utils/tts/microsoft-azure.js'
import { supportConfigurations as voxRoleList } from './utils/tts/voicevox.js'
import {
  buildGuobaConfigPatch,
  guobaConfigSaveMessage
} from './dist/runtime/guoba-config.js'
import { buildGuobaSchemas } from './dist/runtime/guoba-schema.js'
import {
  formatPersonalMemoryOperationsStatusV1,
  productionPersonalMemoryOperationsGatewayV1
} from './dist/runtime/personal-memory-operations.js'
import { createPendingIndicatorConfigPort } from './dist/runtime/presentation/pending-indicator-config.js'
import { pluginId, repositoryUrl } from './dist/runtime/plugin-context.js'
import { updateProductionObservabilityLevel } from './dist/runtime/production-yunzai-agent.js'

const pendingIndicatorConfig = createPendingIndicatorConfigPort(redis)
const personalMemoryOperations = productionPersonalMemoryOperationsGatewayV1(
  () => Config.personalMemoryMode
)

function personalMemoryOperationMessage (result) {
  if (result.status === 'completed') {
    return `保存成功；长期记忆维护已完成，共处理 ${result.affectedRecords} 条派生记录。`
  }
  if (result.status === 'disabled') {
    return '配置已保存；长期记忆当前关闭，未初始化存储或执行维护。'
  }
  return '配置已保存；当前运行实例未提供长期记忆维护端口，请重启后重试。'
}

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
          turnConfirm: await pendingIndicatorConfig.getEnabled(),
          personalMemoryOperationsStatus: formatPersonalMemoryOperationsStatusV1(
            await personalMemoryOperations.inspect()
          ),
          personalMemoryMaintenanceAction: 'none'
        }
      },
      async setConfigData (data, { Result }) {
        // 先完成全部校验，避免无效枚举导致配置只保存一半。
        const normalized = Object.entries(buildGuobaConfigPatch(data, {
          current: Config,
          supportedKeys: supportedConfigKeys,
          virtualKeys: ['turnConfirm', 'personalMemoryMaintenanceAction']
        }))
        const changedFields = []
        let observabilityResult = null
        let personalMemoryOperationResult = null
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
          if (keyPath === 'personalMemoryMaintenanceAction') {
            if (value !== 'none') {
              personalMemoryOperationResult = await personalMemoryOperations.execute(value)
            }
            continue
          }
          if (Config[keyPath] !== value) {
            changedFields.push(keyPath)
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
        const priorityMessage = observabilityMessage ?? (
          personalMemoryOperationResult === null
            ? null
            : personalMemoryOperationMessage(personalMemoryOperationResult)
        )
        return Result.ok({}, guobaConfigSaveMessage(changedFields, priorityMessage))
      }
    }
  }
}
