import { types as utilTypes } from 'node:util'

export interface PersonalMemoryCommandRequestV1 {
  readonly event: unknown
  readonly text: string
  readonly replyText: (text: string) => Promise<void>
  readonly sendPrivateFile: (filePath: string, fileName: string) => Promise<void>
}

export interface PersonalMemoryCommandPortV1 {
  readonly handle: (request: PersonalMemoryCommandRequestV1) => Promise<boolean>
}

let configuredPort: PersonalMemoryCommandPortV1 | null = null

function validPort (value: unknown): value is PersonalMemoryCommandPortV1 {
  if (value === null || typeof value !== 'object' || utilTypes.isProxy(value)) return false
  const descriptor = Object.getOwnPropertyDescriptor(value, 'handle')
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value') &&
    typeof descriptor.value === 'function' && !utilTypes.isProxy(descriptor.value)
}

export function configureProductionPersonalMemoryCommandPortV1 (
  port: PersonalMemoryCommandPortV1
): void {
  if (configuredPort !== null || !validPort(port)) {
    throw new Error('个人长期记忆命令端口已配置或无效。')
  }
  configuredPort = port
}

export function productionPersonalMemoryCommandGatewayV1 (): PersonalMemoryCommandPortV1 {
  return Object.freeze({
    async handle (request: PersonalMemoryCommandRequestV1): Promise<boolean> {
      if (configuredPort !== null) return await configuredPort.handle(request)
      await request.replyText('个人长期记忆当前未启用。请先由机器人主人在锅巴中开启试点模式。')
      return true
    }
  })
}
