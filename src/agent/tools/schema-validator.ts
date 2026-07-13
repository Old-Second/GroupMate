import type { ToolDefinition, ToolEffect, ToolPermissionKind, ToolRisk } from './tool-definition.js'
import type { StrictToolSchema, ToolObjectSchema, ToolSchemaValue } from './tool-schema.js'

const maxDepth = 8
const maxProperties = 64
const maxArrayItems = 32
const maxStringBytes = 16 * 1024
const maxInputBytes = 32 * 1024
const toolNamePattern = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const forbiddenProperties = new Set(['__proto__', 'constructor', 'prototype'])

export type ToolInputErrorCode =
  | 'invalid_schema'
  | 'unsupported_schema_keyword'
  | 'open_object_schema'
  | 'invalid_type'
  | 'invalid_enum'
  | 'missing_required'
  | 'additional_property'
  | 'forbidden_property'
  | 'max_depth_exceeded'
  | 'max_properties_exceeded'
  | 'max_items_exceeded'
  | 'max_string_bytes_exceeded'
  | 'max_input_bytes_exceeded'
  | 'non_finite_number'
  | 'invalid_definition'

export class ToolInputError extends TypeError {
  readonly code: ToolInputErrorCode
  readonly path: string

  constructor (code: ToolInputErrorCode, path = '$') {
    super(`tool validation failed: ${code} at ${path}`)
    this.name = 'ToolInputError'
    this.code = code
    this.path = path
  }

  toJSON (): Readonly<{ name: 'ToolInputError'; code: ToolInputErrorCode; path: string }> {
    return Object.freeze({ name: 'ToolInputError', code: this.code, path: this.path })
  }
}

function isRecord (value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function ownKeys (value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new ToolInputError('unsupported_schema_keyword', path)
  }
}

function validateSchema (schema: unknown, depth = 1, path = '$schema'): asserts schema is StrictToolSchema {
  if (depth > maxDepth) throw new ToolInputError('max_depth_exceeded', path)
  if (!isRecord(schema)) throw new ToolInputError('invalid_schema', path)
  if ('anyOf' in schema) {
    ownKeys(schema, ['anyOf'], path)
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length < 2 || schema.anyOf.length > 4) {
      throw new ToolInputError('invalid_schema', path)
    }
    schema.anyOf.forEach((branch, index) => validateSchema(branch, depth + 1, `${path}.anyOf[${index}]`))
    return
  }
  if (typeof schema.type !== 'string') throw new ToolInputError('invalid_schema', path)
  if (schema.type === 'object') {
    ownKeys(schema, ['type', 'properties', 'required', 'additionalProperties'], path)
    if (schema.additionalProperties !== false) throw new ToolInputError('open_object_schema', path)
    if (!isRecord(schema.properties) || Object.keys(schema.properties).length > maxProperties) {
      throw new ToolInputError('max_properties_exceeded', path)
    }
    if (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string')) {
      throw new ToolInputError('invalid_schema', path)
    }
    const required = schema.required as string[]
    const propertyNames = Object.keys(schema.properties)
    if (propertyNames.some(key => forbiddenProperties.has(key))) throw new ToolInputError('forbidden_property', path)
    if (required.length !== propertyNames.length || propertyNames.some(key => !required.includes(key))) {
      throw new ToolInputError('invalid_schema', path)
    }
    for (const key of propertyNames) validateSchema(schema.properties[key], depth + 1, `${path}.properties.${key}`)
    return
  }
  if (schema.type === 'array') {
    ownKeys(schema, ['type', 'items'], path)
    validateSchema(schema.items, depth + 1, `${path}.items`)
    return
  }
  if (schema.type === 'string' || schema.type === 'number' || schema.type === 'integer' || schema.type === 'boolean') {
    ownKeys(schema, ['type', 'enum'], path)
    if (schema.enum !== undefined) {
      if (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 64) {
        throw new ToolInputError('invalid_schema', path)
      }
      for (const member of schema.enum) validatePrimitive(member, { type: schema.type } as StrictToolSchema, path)
    }
    return
  }
  if (schema.type === 'null') {
    ownKeys(schema, ['type'], path)
    return
  }
  throw new ToolInputError('invalid_schema', path)
}

function validatePrimitive (value: unknown, schema: StrictToolSchema, path: string): unknown {
  if ('anyOf' in schema || schema.type === 'object' || schema.type === 'array') {
    throw new ToolInputError('invalid_schema', path)
  }
  if (schema.type === 'null') {
    if (value !== null) throw new ToolInputError('invalid_type', path)
    return null
  }
  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new ToolInputError('invalid_type', path)
    if (Buffer.byteLength(value, 'utf8') > maxStringBytes) throw new ToolInputError('max_string_bytes_exceeded', path)
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new ToolInputError('invalid_type', path)
  } else {
    if (typeof value !== 'number') throw new ToolInputError('invalid_type', path)
    if (!Number.isFinite(value)) throw new ToolInputError('non_finite_number', path)
    if (schema.type === 'integer' && !Number.isInteger(value)) throw new ToolInputError('invalid_type', path)
  }
  if ('enum' in schema && schema.enum !== undefined && !schema.enum.some(member => Object.is(member, value))) {
    throw new ToolInputError('invalid_enum', path)
  }
  return value
}

function cloneValue (schema: StrictToolSchema, value: unknown, depth: number, path: string): unknown {
  if (depth > maxDepth) throw new ToolInputError('max_depth_exceeded', path)
  if ('anyOf' in schema) {
    let lastError: unknown
    for (const branch of schema.anyOf) {
      try {
        return cloneValue(branch, value, depth + 1, path)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError instanceof ToolInputError ? lastError : new ToolInputError('invalid_type', path)
  }
  if (schema.type === 'object') {
    if (!isRecord(value)) throw new ToolInputError('invalid_type', path)
    const keys = Object.keys(value)
    if (keys.length > maxProperties) throw new ToolInputError('max_properties_exceeded', path)
    for (const key of keys) {
      if (forbiddenProperties.has(key)) throw new ToolInputError('forbidden_property', `${path}.${key}`)
      if (!Object.hasOwn(schema.properties, key)) throw new ToolInputError('additional_property', `${path}.${key}`)
    }
    for (const key of schema.required) {
      if (!Object.hasOwn(value, key)) throw new ToolInputError('missing_required', `${path}.${key}`)
    }
    const output = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(schema.properties)) {
      output[key] = cloneValue(schema.properties[key], value[key], depth + 1, `${path}.${key}`)
    }
    return Object.freeze(output)
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new ToolInputError('invalid_type', path)
    if (value.length > maxArrayItems) throw new ToolInputError('max_items_exceeded', path)
    return Object.freeze(value.map((item, index) => cloneValue(schema.items, item, depth + 1, `${path}[${index}]`)))
  }
  return validatePrimitive(value, schema, path)
}

export function validateToolInput<Schema extends StrictToolSchema> (schema: Schema, input: unknown): ToolSchemaValue<Schema> {
  validateSchema(schema)
  let serialized: string
  try {
    serialized = JSON.stringify(input)
  } catch {
    throw new ToolInputError('invalid_type')
  }
  if (typeof serialized !== 'string') throw new ToolInputError('invalid_type')
  if (Buffer.byteLength(serialized, 'utf8') > maxInputBytes) throw new ToolInputError('max_input_bytes_exceeded')
  return cloneValue(schema, input, 1, '$') as ToolSchemaValue<Schema>
}

export function validateToolInputRecord (
  schema: ToolObjectSchema,
  input: unknown
): Readonly<Record<string, unknown>> {
  validateSchema(schema)
  let serialized: string
  try {
    serialized = JSON.stringify(input)
  } catch {
    throw new ToolInputError('invalid_type')
  }
  if (typeof serialized !== 'string') throw new ToolInputError('invalid_type')
  if (Buffer.byteLength(serialized, 'utf8') > maxInputBytes) throw new ToolInputError('max_input_bytes_exceeded')
  return cloneValue(schema, input, 1, '$') as Readonly<Record<string, unknown>>
}

const effects: readonly ToolEffect[] = ['read_only', 'visible_output', 'progress_output', 'side_effect']
const risks: readonly ToolRisk[] = ['low', 'medium', 'high']
const permissions: readonly ToolPermissionKind[] = [
  'any_user', 'current_channel', 'cross_channel', 'self_member',
  'group_moderator', 'group_owner_or_master', 'bot_group_owner'
]

export function validateToolDefinition<Input> (definition: ToolDefinition<Input>): ToolDefinition<Input> {
  if (!isRecord(definition)) throw new ToolInputError('invalid_definition')
  if (!toolNamePattern.test(definition.name) || definition.version !== 1 ||
    typeof definition.description !== 'string' || definition.description.trim().length === 0 ||
    Buffer.byteLength(definition.description, 'utf8') > 1024) {
    throw new ToolInputError('invalid_definition')
  }
  if (!Array.isArray(definition.aliases) || definition.aliases.some(alias => !toolNamePattern.test(alias)) ||
    new Set(definition.aliases).size !== definition.aliases.length || definition.aliases.includes(definition.name)) {
    throw new ToolInputError('invalid_definition')
  }
  validateSchema(definition.inputSchema)
  if (!('type' in definition.inputSchema) || definition.inputSchema.type !== 'object') {
    throw new ToolInputError('invalid_definition')
  }
  if (!effects.includes(definition.effect) || !risks.includes(definition.risk) ||
    !permissions.includes(definition.permission) ||
    !['none', 'call', 'semantic'].includes(definition.idempotency) ||
    !['none', 'fixed_hosts', 'open_http'].includes(definition.network) ||
    typeof definition.readOnly !== 'boolean' || typeof definition.destructive !== 'boolean' ||
    typeof definition.openWorld !== 'boolean' || typeof definition.resolveTarget !== 'function' ||
    typeof definition.execute !== 'function' || !Number.isInteger(definition.timeoutMs) ||
    definition.timeoutMs < 100 || definition.timeoutMs > 30_000 ||
    !Number.isInteger(definition.maxOutputBytes) || definition.maxOutputBytes <= 0 ||
    definition.maxOutputBytes > 64 * 1024) {
    throw new ToolInputError('invalid_definition')
  }
  if ((definition.effect === 'read_only') !== definition.readOnly ||
    (definition.destructive && (definition.effect !== 'side_effect' || definition.readOnly || definition.risk !== 'high')) ||
    (definition.readOnly && definition.idempotency !== 'none') ||
    (!definition.readOnly && definition.idempotency !== 'call' && definition.idempotency !== 'semantic')) {
    throw new ToolInputError('invalid_definition')
  }
  const access = definition.crossChannelAccess
  const validCrossChannelAccess = isRecord(access) &&
    Object.keys(access).sort().join(',') === 'group,private' &&
    ['disabled', 'master', 'everyone'].includes(String(access.private)) &&
    ['disabled', 'master', 'everyone'].includes(String(access.group))
  if ((definition.permission === 'cross_channel') !== validCrossChannelAccess) {
    throw new ToolInputError('invalid_definition')
  }
  return definition
}
