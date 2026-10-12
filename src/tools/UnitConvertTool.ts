import { readResourceKeys } from '../agent/tools/resource-key.js'
import type { ToolDefinition } from '../agent/tools/tool-definition.js'
import { boundedJson, invalidArguments, readOnlyDefinition, textResult } from './query-tool-support.js'

type Unit = readonly [dimension: string, scale: number, offset: number]
const units: Readonly<Record<string, Unit>> = Object.freeze({
  mm: ['length', .001, 0], cm: ['length', .01, 0], m: ['length', 1, 0], km: ['length', 1000, 0],
  in: ['length', .0254, 0], ft: ['length', .3048, 0], yd: ['length', .9144, 0], mi: ['length', 1609.344, 0],
  mg: ['mass', .000001, 0], g: ['mass', .001, 0], kg: ['mass', 1, 0], lb: ['mass', .45359237, 0], oz: ['mass', .028349523125, 0],
  s: ['time', 1, 0], min: ['time', 60, 0], h: ['time', 3600, 0], day: ['time', 86400, 0],
  ml: ['volume', .001, 0], L: ['volume', 1, 0], 'm/s': ['speed', 1, 0], 'km/h': ['speed', 1 / 3.6, 0], mph: ['speed', .44704, 0],
  J: ['energy', 1, 0], kJ: ['energy', 1000, 0], kcal: ['energy', 4184, 0],
  C: ['temperature', 1, 273.15], F: ['temperature', 5 / 9, 273.15 - 32 * 5 / 9], K: ['temperature', 1, 0],
  B: ['data', 1, 0], KB: ['data', 1000, 0], MB: ['data', 1e6, 0], GB: ['data', 1e9, 0],
  KiB: ['data', 1024, 0], MiB: ['data', 1024 ** 2, 0], GiB: ['data', 1024 ** 3, 0]
})

export function createUnitConvertTool (): ToolDefinition {
  return readOnlyDefinition({
    name: 'unitConvert', description: `纯本地同维度单位换算，温度支持偏移。单位区分大小写：${Object.keys(units).join(', ')}。day=24小时；KB为1000字节、KiB为1024字节；不支持货币汇率或不同维度互换。`,
    inputSchema: { type: 'object', properties: { value: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } },
      required: ['value', 'from', 'to'], additionalProperties: false },
    network: 'none', retrySafe: true, resourceKeys: input => readResourceKeys('unitConvert', input),
    execute: async input => {
      const from = typeof input.from === 'string' && Object.hasOwn(units, input.from) ? units[input.from] : undefined
      const to = typeof input.to === 'string' && Object.hasOwn(units, input.to) ? units[input.to] : undefined
      if (from === undefined || to === undefined || from[0] !== to[0] || typeof input.value !== 'number' || !Number.isFinite(input.value)) return invalidArguments('请使用支持的同维度单位和有限数值。')
      const base = input.value * from[1] + from[2]
      const result = (base - to[2]) / to[1]
      if (!Number.isFinite(result) || (from[0] === 'temperature' && base < -1e-10)) return invalidArguments('换算溢出或温度低于绝对零度。')
      return textResult(boundedJson({ value: input.value, from: input.from, to: input.to, result: Number(result.toPrecision(14)), dimension: from[0] }))
    }
  })
}
