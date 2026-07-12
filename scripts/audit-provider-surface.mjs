import { execFile } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  providerSurfaceIds,
  providerSurfaceManifest
} from '../dist/runtime/provider-surface-manifest.js'

const execFileAsync = promisify(execFile)
export const MAX_PROVIDER_SURFACE_FILE_BYTES = 524288
export const MAX_PROVIDER_SURFACE_TOTAL_BYTES = 8388608

const lexicalExtensions = ['*.js', '*.ts', '*.json', '*.mjs', '*.patch']
const configSurfacePaths = new Set(['utils/config.js', 'config/config.example.json'])
const uiSurfacePaths = new Set(['guoba.support.js', 'resources/view/setting_view.json'])
const dependencySurfacePaths = new Set(['package.json'])

function isExcludedPath (path) {
  return providerSurfaceManifest.preservedExclusions.directories.some(directory =>
    path.startsWith(directory)
  ) ||
    providerSurfaceManifest.preservedExclusions.files.includes(path) ||
    providerSurfaceManifest.preservedExclusions.paths.includes(path)
}

function createDefinitions () {
  return providerSurfaceIds.map(id => ({
    id,
    exactSources: new Set(providerSurfaceManifest.sources[id]),
    markers: providerSurfaceManifest.lexicalMarkers[id].map(marker => marker.toLowerCase()),
    commands: providerSurfaceManifest.commands[id].map(marker => marker.toLowerCase()),
    configFields: providerSurfaceManifest.configFields[id].map(marker => marker.toLowerCase()),
    uiFields: providerSurfaceManifest.uiFields[id].map(marker => marker.toLowerCase()),
    dependencies: providerSurfaceManifest.dependencies[id].map(marker => marker.toLowerCase()),
    hits: []
  }))
}

async function getCandidatePaths (cwd) {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '-z', '--', ...lexicalExtensions],
    { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }
  )
  const trackedPaths = stdout.split('\0').filter(Boolean)
  const trackedPathSet = new Set(trackedPaths)
  const exactSources = providerSurfaceIds.flatMap(id => providerSurfaceManifest.sources[id])

  return [...new Set([
    ...exactSources.filter(path => trackedPathSet.has(path)),
    ...trackedPaths
  ])]
    .filter(path => !isExcludedPath(path))
}

function addHit (definition, path, line) {
  if (definition.hits.some(hit => hit.path === path && hit.line === line)) return
  definition.hits.push({ path, line })
}

function includesIdentifier (line, identifier) {
  let index = line.indexOf(identifier)
  while (index !== -1) {
    const before = line[index - 1]
    const after = line[index + identifier.length]
    const isIdentifierCharacter = character => character && /[a-z0-9_$]/i.test(character)
    if (!isIdentifierCharacter(before) && !isIdentifierCharacter(after)) return true
    index = line.indexOf(identifier, index + identifier.length)
  }
  return false
}

function matchesScopedManifestEntry (definition, path, line) {
  if ((path.startsWith('apps/') || path === 'resources/help.json') &&
      definition.commands.some(marker => line.includes(marker))) {
    return true
  }
  if (configSurfacePaths.has(path) &&
      definition.configFields.some(marker => includesIdentifier(line, marker))) {
    return true
  }
  if (uiSurfacePaths.has(path) &&
      definition.uiFields.some(marker => includesIdentifier(line, marker))) {
    return true
  }
  return dependencySurfacePaths.has(path) &&
    definition.dependencies.some(marker => line.includes(marker))
}

function getBoundedLimit (value, ceiling) {
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, ceiling)
    : ceiling
}

export async function scanProviderSurface (rootUrl, options = {}) {
  const cwd = fileURLToPath(rootUrl)
  const maxFileBytes = getBoundedLimit(
    options.maxFileBytes,
    MAX_PROVIDER_SURFACE_FILE_BYTES
  )
  const maxTotalBytes = getBoundedLimit(
    options.maxTotalBytes,
    MAX_PROVIDER_SURFACE_TOTAL_BYTES
  )
  const paths = await getCandidatePaths(cwd)
  const definitions = createDefinitions()
  const skipped = []
  let bytesRead = 0

  for (const path of paths) {
    const absolutePath = resolve(cwd, path)
    let fileStat
    try {
      fileStat = await lstat(absolutePath)
    } catch {
      skipped.push({ path, reason: 'unreadable', bytes: 0 })
      continue
    }
    if (!fileStat.isFile()) {
      skipped.push({ path, reason: 'not-regular-file', bytes: fileStat.size })
      continue
    }
    if (fileStat.size > maxFileBytes) {
      skipped.push({ path, reason: 'file-too-large', bytes: fileStat.size })
      continue
    }
    if (bytesRead + fileStat.size > maxTotalBytes) {
      skipped.push({ path, reason: 'total-budget-exceeded', bytes: fileStat.size })
      continue
    }

    let content
    try {
      content = await readFile(absolutePath, 'utf8')
    } catch {
      skipped.push({ path, reason: 'unreadable', bytes: fileStat.size })
      continue
    }
    bytesRead += fileStat.size

    for (const definition of definitions) {
      if (definition.exactSources.has(path)) addHit(definition, path, 1)
    }

    const lines = content.split('\n')
    lines.forEach((line, index) => {
      const normalizedLine = line.toLowerCase()
      definitions.forEach(definition => {
        if (definition.markers.some(marker => normalizedLine.includes(marker)) ||
            matchesScopedManifestEntry(definition, path, normalizedLine)) {
          addHit(definition, path, index + 1)
        }
      })
    })
  }

  return {
    hits: definitions.map(({ id, hits }) => ({ id, hits })),
    skipped,
    bytesRead
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await scanProviderSurface(new URL('../', import.meta.url))
  console.log(JSON.stringify({
    categories: result.hits.map(({ id, hits }) => ({ id, hits: hits.length })),
    skipped: result.skipped,
    bytesRead: result.bytesRead
  }, null, 2))
}
