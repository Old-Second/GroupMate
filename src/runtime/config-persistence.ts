import { isDeepStrictEqual } from 'node:util'

type Configuration = Record<string, unknown>

export function selectPersistedConfig (
  configuration: Readonly<Configuration>,
  defaults: Readonly<Configuration>
): Configuration {
  const persisted: Configuration = {}
  for (const [key, value] of Object.entries(configuration)) {
    if (!isDeepStrictEqual(value, defaults[key])) {
      persisted[key] = value
    }
  }
  return persisted
}

export function selectImportableConfig (
  candidate: Readonly<Configuration>,
  supportedKeys: readonly string[]
): Configuration {
  const supported = new Set(supportedKeys)
  return Object.fromEntries(
    Object.entries(candidate).filter(([key]) => supported.has(key))
  )
}
