export type ToolSchemaPrimitive = string | number | boolean | null

export interface ToolStringSchema {
  readonly type: 'string'
  readonly enum?: readonly string[]
}

export interface ToolNumberSchema {
  readonly type: 'number' | 'integer'
  readonly enum?: readonly number[]
}

export interface ToolBooleanSchema {
  readonly type: 'boolean'
  readonly enum?: readonly boolean[]
}

export interface ToolNullSchema {
  readonly type: 'null'
}

export interface ToolArraySchema {
  readonly type: 'array'
  readonly items: StrictToolSchema
}

export interface ToolObjectSchema {
  readonly type: 'object'
  readonly properties: Readonly<Record<string, StrictToolSchema>>
  readonly required: readonly string[]
  readonly additionalProperties: false
}

export interface ToolAnyOfSchema {
  readonly anyOf: readonly StrictToolSchema[]
}

export type StrictToolSchema =
  | ToolStringSchema
  | ToolNumberSchema
  | ToolBooleanSchema
  | ToolNullSchema
  | ToolArraySchema
  | ToolObjectSchema
  | ToolAnyOfSchema

export type ToolSchemaValue<Schema extends StrictToolSchema> =
  Schema extends { readonly anyOf: readonly (infer Branch)[] }
    ? Branch extends StrictToolSchema ? ToolSchemaValue<Branch> : never
    : Schema extends { readonly type: 'object'; readonly properties: infer Properties }
      ? Properties extends Readonly<Record<string, StrictToolSchema>>
        ? Readonly<{ [Key in keyof Properties]: ToolSchemaValue<Properties[Key]> }>
        : never
      : Schema extends { readonly type: 'array'; readonly items: infer Item }
        ? Item extends StrictToolSchema ? readonly ToolSchemaValue<Item>[] : never
        : Schema extends { readonly type: 'string' }
          ? string
          : Schema extends { readonly type: 'number' | 'integer' }
            ? number
            : Schema extends { readonly type: 'boolean' }
              ? boolean
              : Schema extends { readonly type: 'null' }
                ? null
                : never
