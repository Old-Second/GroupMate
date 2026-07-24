import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { buildGuobaSchemas } from '../../src/runtime/guoba-schema.js'
import {
  PHASE_7B_PRODUCTION_TOOL_FACTORIES,
  PHASE_7B_PRODUCTION_TOOL_NAMES,
  auditPhase7bMemoryWiring,
  auditPhase7bProductionReachability,
  collectPhase7bProductionToolNames,
  phase7bBridgeDependenciesAreClosed,
  phase7bBridgeMemoryDefaultOffIsExact,
  phase7bComputedImportBoundaryIsClosed,
  phase7bMemoryControlFieldIsForbidden,
  phase7bMemoryTelemetrySourceFindings,
  phase7bOutboxSurfaceIsBodyFree,
  phase7bRuntimeMemoryRecallSeamIsExact
} from '../../src/verification/phase-7b-memory-report.js'

const PROJECT_ROOT = process.cwd()

const EXPECTED_TOOL_FACTORIES = Object.freeze([
  'createDrawTool',
  'createProcessPictureTool',
  'createSendPictureTool',
  'createSendVideoTool',
  'createSendAvatarTool',
  'createSendMusicTool',
  'createSendAudioMessageTool',
  'createSendDiceTool',
  'createSendRPSTool',
  'createSendMessageTool',
  'createEditCardTool',
  'createJinyanTool',
  'createKickOutTool',
  'createSetTitleTool',
  'createHandleMessageTool',
  'createSearchTool',
  'createWebsiteTool',
  'createWeatherTool',
  'createGithubTool',
  'createQueryUserinfoTool',
  'createQueryGenshinTool',
  'createQueryStarRailTool',
  'createSearchImageTool',
  'createSearchVideoTool',
  'createSearchMusicTool',
  'createImageCaptionTool'
])

const EXPECTED_TOOL_NAMES = Object.freeze([
  'draw',
  'processPicture',
  'sendPicture',
  'sendVideo',
  'sendAvatar',
  'sendMusic',
  'sendAudioMessage',
  'sendDice',
  'sendRPS',
  'sendMessage',
  'editCard',
  'jinyan',
  'kickOut',
  'setTitle',
  'handleMsg',
  'search',
  'website',
  'weather',
  'github',
  'queryUserinfo',
  'queryGenshin',
  'queryStarRail',
  'searchImage',
  'searchVideo',
  'searchMusic',
  'imageCaption'
])

test('Phase 7B production wiring remains explicitly memory-disabled', async () => {
  const audit = await auditPhase7bMemoryWiring(PROJECT_ROOT)

  assert.equal(audit.schemaVersion, 1)
  assert.equal(audit.productionMemoryDefaultOff, true)
  assert.equal(audit.productionDependenciesClosed, true)
  assert.equal(audit.memoryRecallSeamExact, true)
  assert.equal(audit.runtimeMemoryImports, 1)
  assert.equal(audit.runtimeMemoryQueries, 0)
  assert.equal(audit.runtimeMemoryProposals, 0)
  assert.equal(audit.runtimeContextSourceImports, 0)
  assert.equal(audit.reachableGraphComplete, true)
  assert.equal(audit.reachableMemoryModules, 0)
  assert.equal(audit.reachableContextSourceModules, 0)
  assert.equal(audit.forbiddenMemoryToolFactories, 0)
  assert.equal(audit.forbiddenMemoryToolNames, 0)
  assert.equal(audit.productionToolNamesExact, true)
  assert.equal(audit.guobaMemoryEnableFields, 0)
  assert.equal(audit.configMemoryEnableFields, 0)
  assert.equal(audit.memoryTelemetryEdges, 0)
  assert.deepEqual(audit.coldImport, {
    passed: true,
    timerCalls: 0,
    redisEvalCalls: 0,
    createdFiles: 0
  })
  assert.equal(audit.passed, true)
})

test('production tool inventory is exact and has no memory capability', async () => {
  assert.deepEqual(PHASE_7B_PRODUCTION_TOOL_FACTORIES, EXPECTED_TOOL_FACTORIES)
  assert.deepEqual(PHASE_7B_PRODUCTION_TOOL_NAMES, EXPECTED_TOOL_NAMES)
  const source = await readFile(path.join(
    PROJECT_ROOT,
    'src/runtime/tools/tool-runtime-factory.ts'
  ), 'utf8')
  const calls = [...source.matchAll(/\b(create[A-Z][A-Za-z0-9]*Tool)\(/g)]
    .map(match => match[1])
  assert.deepEqual(calls, EXPECTED_TOOL_FACTORIES)
  assert.equal(calls.some(name => /Memory|Remember|Forget|Qdrant/.test(name ?? '')), false)
  const names = collectPhase7bProductionToolNames()
  assert.deepEqual(names, EXPECTED_TOOL_NAMES)
  assert.equal(names.some(name => /Memory|Remember|Forget|Qdrant/i.test(name)), false)
})

test('production reachability follows indirect and comment-separated imports', () => {
  const indirect = auditPhase7bProductionReachability({
    'src/runtime/production-yunzai-agent.ts': "import './bridge.js'\n",
    'src/runtime/bridge.ts': "import '../middle.js'\n",
    'src/middle.ts': "import './agent/memory/sqlite-memory-database.js'\n",
    'src/agent/memory/sqlite-memory-database.ts': 'export const marker = true\n'
  })
  assert.equal(indirect.complete, true)
  assert.equal(indirect.reachableFiles, 4)
  assert.equal(indirect.forbiddenMemoryModules, 1)

  for (const source of [
    "const marker = true; import '../agent/memory/sqlite-memory-database.js'\n",
    "import /* reviewed-comment */ '../agent/memory/sqlite-memory-database.js'\n",
    "void import /* reviewed-comment */('../agent/memory/sqlite-memory-database.js')\n"
  ]) {
    const audit = auditPhase7bProductionReachability({
      'src/runtime/production-yunzai-agent.ts': source,
      'src/agent/memory/sqlite-memory-database.ts': 'export const marker = true\n'
    })
    assert.equal(audit.complete, true)
    assert.equal(audit.forbiddenMemoryModules, 1)
  }

  assert.throws(() => auditPhase7bProductionReachability({
    'src/runtime/production-yunzai-agent.ts': "import './bridge.js'\n",
    'src/runtime/bridge.js': 'export const marker = true\n'
  }), /source graph/i)
  assert.deepEqual(auditPhase7bProductionReachability({
    'src/runtime/production-yunzai-agent.ts': 'const specifier = getTarget()\nvoid import(specifier)\n'
  }), {
    complete: false,
    reachableFiles: 1,
    forbiddenMemoryModules: 0,
    forbiddenContextSourceModules: 0
  })
  assert.equal(auditPhase7bProductionReachability({
    'src/runtime/production-yunzai-agent.ts': "import '#memory-alias'\n"
  }).complete, false)
  for (const specifier of ['qdrant-client', '@scope/memory']) {
    assert.equal(auditPhase7bProductionReachability({
      'src/runtime/production-yunzai-agent.ts': `import '${specifier}'\n`
    }).complete, false)
  }
})

test('production bridge dependency surface and outbox payload fail closed on new seams', async () => {
  const bridge = await readFile(path.join(
    PROJECT_ROOT,
    'src/runtime/agent-service-bridge.ts'
  ), 'utf8')
  assert.equal(phase7bBridgeDependenciesAreClosed(bridge), true)
  assert.equal(phase7bBridgeMemoryDefaultOffIsExact(bridge), true)
  assert.equal(phase7bBridgeMemoryDefaultOffIsExact(bridge.replace(
    '  readonly personalMemoryRecallSource?: YunzaiPersonalMemoryRecallSourceV1',
    '  readonly personalMemoryRecallSource: YunzaiPersonalMemoryRecallSourceV1'
  )), false)
  assert.equal(phase7bBridgeDependenciesAreClosed(bridge.replace(
    '  readonly observations?:',
    '  readonly memoryRepository?: unknown\n  readonly observations?:'
  )), false)
  for (const mutation of [
    '  readonly progressPresenter: unknown',
    '  readonly [key: string]: unknown',
    '  inspect(): void'
  ]) {
    assert.equal(phase7bBridgeDependenciesAreClosed(bridge.replace(
      '  readonly progressPresenter: RunProgressPresenter',
      mutation
    )), false)
  }

  const memoryDomain = await readFile(path.join(
    PROJECT_ROOT,
    'src/agent/memory/memory-domain.ts'
  ), 'utf8')
  assert.equal(phase7bOutboxSurfaceIsBodyFree(memoryDomain), true)
  for (const field of ['contentHash', 'revisionHash', 'actorRef']) {
    assert.equal(phase7bOutboxSurfaceIsBodyFree(memoryDomain.replace(
      '  readonly payloadHash: string',
      `  readonly payloadHash: string\n  readonly ${field}: string`
    )), false)
  }
  for (const mutation of [
    '  readonly text?: string',
    '  readonly [key: string]: unknown',
    '  inspect(): void',
    '  readonly payloadHash: number'
  ]) {
    assert.equal(phase7bOutboxSurfaceIsBodyFree(memoryDomain.replace(
      '  readonly payloadHash: string',
      mutation
    )), false)
  }
})

test('computed plugin imports and memory configuration aliases are exact', async () => {
  const source = await readFile(path.join(
    PROJECT_ROOT,
    'src/runtime/tools/yunzai-tool-runtime.ts'
  ), 'utf8')
  assert.equal(phase7bComputedImportBoundaryIsClosed(source), true)
  assert.equal(phase7bComputedImportBoundaryIsClosed(source.replace(
    '../../../../ap-plugin/apps/aiPainting.js',
    '../../agent/memory/memory-domain.js'
  )), false)
  assert.equal(phase7bComputedImportBoundaryIsClosed(`${source}\nasync function other (specifier: string) {\n  return import(specifier)\n}\n`), false)
  for (const field of [
    'memoryQueryEnabled',
    'longTermMemoryReadEnabled',
    'qdrantUrl',
    'semantic_memory_index'
  ]) assert.equal(phase7bMemoryControlFieldIsForbidden(field), true)
  assert.equal(phase7bMemoryControlFieldIsForbidden('observabilityLevel'), false)

  const report = await readFile(path.join(
    PROJECT_ROOT,
    'src/verification/phase-7b-memory-report.ts'
  ), 'utf8')
  assert.equal([...report.matchAll(/killSignal: 'SIGKILL'/g)].length, 2)
  assert.match(report, /const parentCreatedFiles = \(await readdir\(temporary\)\)\.length/)
})

test('runtime memory seam and telemetry edges reject shorthand and comment bypasses', () => {
  const exact = {
    'src/runtime/agent-service-bridge.ts': [
      'interface D { readonly personalMemoryRecallSource?: Source }',
      'const value = dependencies.personalMemoryRecallSource'
    ].join('\n')
  }
  assert.equal(phase7bRuntimeMemoryRecallSeamIsExact(exact), true)
  for (const source of [
    'interface D { readonly personalMemoryRecallSource: Source }\nconst value = dependencies.personalMemoryRecallSource\n',
    'interface D { readonly personalMemoryRecallSource?: Source }\n',
    'const memoryStore = new OtherStore()\n',
    'interface D { readonly personalMemoryRecallSource?: Source }\nconst value = other.personalMemoryRecallSource\n'
  ]) assert.equal(phase7bRuntimeMemoryRecallSeamIsExact({
    'src/runtime/agent-service-bridge.ts': source
  }), false)

  assert.equal(phase7bMemoryTelemetrySourceFindings(
    'src/agent/memory/unsafe.ts',
    "import /* comment */ { publish } from '../../runtime/observability/unsafe.js'\npublish('body')\n",
    'memory'
  ) > 0, true)
  assert.equal(phase7bMemoryTelemetrySourceFindings(
    'src/runtime/observability/unsafe.ts',
    "import /* comment */ { value } from '../../agent/memory/memory-domain.js'\nvoid value\n",
    'consumer'
  ) > 0, true)
  assert.equal(phase7bMemoryTelemetrySourceFindings(
    'src/agent/memory/unsafe.ts',
    'const sink = console\nsink.log(1)\n',
    'memory'
  ) > 0, true)
  assert.equal(phase7bMemoryTelemetrySourceFindings(
    'src/agent/memory/safe.ts',
    "import { createHash } from 'node:crypto'\nvoid createHash\n",
    'memory'
  ), 0)
})

test('Guoba and example config expose no long-term memory enable surface', async () => {
  const fields = buildGuobaSchemas({
    vitsRoleOptions: [],
    voicevoxRoleOptions: [],
    azureRoleOptions: []
  }).flatMap(schema => schema.field === undefined ? [] : [schema.field])
  const config = JSON.parse(await readFile(path.join(
    PROJECT_ROOT,
    'config/config.example.json'
  ), 'utf8')) as Record<string, unknown>
  const forbidden = new Set([
    'memoryEnabled',
    'longTermMemoryEnabled',
    'memoryReadEnabled',
    'memoryWriteEnabled',
    'memoryQuery',
    'memoryProposal',
    'qdrantEnabled'
  ])
  assert.deepEqual(fields.filter(field => forbidden.has(field)), [])
  assert.deepEqual(Object.keys(config).filter(field => forbidden.has(field)), [])
})

test('Phase 7B verification entry runs the built Task 11 artifact', async () => {
  const script = await readFile(path.join(PROJECT_ROOT, 'scripts/verify-phase-7b.mjs'), 'utf8')
  assert.match(script, /^import \{ main \} from '\.\.\/dist\/verification\/phase-7b-memory-report\.js'\nawait main\(\)\n?$/)
  const report = await readFile(path.join(
    PROJECT_ROOT,
    'src/verification/phase-7b-memory-report.ts'
  ), 'utf8')
  assert.doesNotMatch(report, /skipSourceDistCheck/)
  assert.match(report, /security = await securityAudit\(root\)/)
  const pkg = JSON.parse(await readFile(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as {
    readonly scripts?: Readonly<Record<string, string>>
  }
  assert.equal(pkg.scripts?.['verify:phase7b'],
    'pnpm run build && pnpm exec tsc -p tsconfig.test.json && node --test --test-concurrency=1 .test-dist/test/unit/*memory*.test.js && node scripts/verify-phase-7b.mjs')
  assert.equal(pkg.scripts?.['verify:phase7b']?.includes('build'), true)
})
