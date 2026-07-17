import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'

const root = process.cwd()
const localImport = /(?:import\s+(?:[^'";]+?\s+from\s+)?|import\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g

async function source (file: string): Promise<string> {
  return await readFile(path.join(root, file), 'utf8')
}

async function exists (file: string): Promise<boolean> {
  try {
    await access(path.join(root, file))
    return true
  } catch {
    return false
  }
}

async function resolveImport (from: string, specifier: string): Promise<string | null> {
  const candidate = path.normalize(path.join(path.dirname(from), specifier))
  for (const file of [candidate, `${candidate}.js`, path.join(candidate, 'index.js')]) {
    if (await exists(file)) return file
  }
  return null
}

async function productionGraph (): Promise<ReadonlyMap<string, string>> {
  const sources = new Map<string, string>()
  const queue = ['index.js']
  while (queue.length > 0) {
    const file = queue.shift() as string
    if (sources.has(file)) continue
    const contents = await source(file)
    sources.set(file, contents)
    localImport.lastIndex = 0
    for (const match of contents.matchAll(localImport)) {
      const resolved = await resolveImport(file, match[2] as string)
      if (resolved !== null && !sources.has(resolved)) queue.push(resolved)
    }
  }
  return sources
}

test('Phase 5 production entries reach one run engine and one OpenAI-compatible transport', async () => {
  const graph = await productionGraph()
  const files = [...graph.keys()].sort()
  assert.deepEqual(
    files.filter(file => file === 'dist/agent/run/run-engine.js'),
    ['dist/agent/run/run-engine.js']
  )
  assert.deepEqual(
    files.filter(file => file === 'dist/agent/model/openai-compatible-adapter.js'),
    ['dist/agent/model/openai-compatible-adapter.js']
  )
  assert.equal(files.includes('model/core.js'), false)
  assert.equal(files.includes('utils/openai/chatgpt-api.js'), false)
  assert.equal(files.includes('dist/runtime/completion-facade.js'), false)
  assert.equal(files.includes('utils/chat.js'), false)
  const combined = [...graph.values()].join('\n')
  assert.doesNotMatch(
    combined,
    /agentRuntimeMode|legacyRuntime|newRuntime|catch\s*\([^)]*\)\s*\{[^}]*model\/core\.js/s
  )
})

test('Phase 5 approval app accepts only an exact quoted decision', async () => {
  const approval = await source('apps/approval.js')
  assert.match(approval, /\^\(确认\|拒绝\)\$/)
  assert.doesNotMatch(approval, /#确认|#拒绝|token|finalize/i)
  assert.match(approval, /priority:\s*1143/)
  assert.match(
    approval,
    /getProductionYunzaiAgent\(\)\.approvalController\.confirmToolOperation\(event\)/
  )
})

test('Task 2 host entries hand off one exact presentation intent scalar', async () => {
  const [chat, bym, bridge] = await Promise.all([
    source('src/runtime/yunzai-chat-controller.ts'),
    source('src/runtime/yunzai-bym-controller.ts'),
    source('src/runtime/agent-service-bridge.ts')
  ])
  assert.match(chat, /kind:\s*'ordinary'/)
  assert.match(chat, /forcePicture/)
  assert.match(chat, /presentationRoute:\s*prepared\.route/)
  assert.match(bym, /kind:\s*'proactive'/)
  assert.match(bym, /recallAfterMs/)
  assert.match(bym, /Math\.min\(\s*Math\.max\(Math\.trunc\(/)
  assert.doesNotMatch(bridge, /bymFuckRecallTime|forcePictureMode/)
  assert.match(bridge, /onTerminalSnapshot:\s*snapshot\s*=>\s*terminalFacts\.acceptSnapshot\(snapshot\)/)
  assert.match(bridge, /onTerminalCommitReceipt:\s*receipt\s*=>\s*terminalFacts\.acceptCommitReceipt\(receipt\)/)
})

test('Task 5 contracts have one canonical owner and consumers import those types', async () => {
  const [completion, observation, service, bridge, router, routerTest] = await Promise.all([
    source('src/agent/contracts/completion.ts'),
    source('src/runtime/request-observation.ts'),
    source('src/runtime/agent-service.ts'),
    source('src/runtime/agent-service-bridge.ts'),
    source('src/runtime/run-approval-router.ts'),
    source('test/unit/approval-reference-router.test.ts')
  ])
  assert.match(completion, /export type SessionPersistenceOutcome\s*=/)
  assert.doesNotMatch(observation, /(?:export\s+)?type SessionPersistenceOutcome\s*=/)
  assert.match(observation, /export type \{ SessionPersistenceOutcome \} from '\.\.\/agent\/contracts\/completion\.js'/)
  assert.match(service, /import type \{ SessionPersistenceOutcome \} from '\.\.\/agent\/contracts\/completion\.js'/)
  assert.match(observation, /export interface ApprovalRecoveryDeferred/)
  assert.doesNotMatch(service, /export interface ApprovalRecoveryDeferred/)
  assert.equal(
    [observation, service, bridge, router]
      .flatMap(value => value.match(/export interface ApprovalRecoveryDeferred/g) ?? [])
      .length,
    1
  )
  for (const [value, modulePath] of [
    [service, "from './request-observation.js'"],
    [bridge, "from './request-observation.js'"],
    [router, "from './request-observation.js'"],
    [routerTest, "from '../../src/runtime/request-observation.js'"]
  ]) {
    assert.equal(value.includes('ApprovalRecoveryDeferred'), true)
    assert.equal(value.includes(modulePath), true)
  }
})

test('index initializes the graph before importing apps', async () => {
  const index = await source('index.js')
  const initialize = index.indexOf('initializeProductionYunzaiAgent({')
  const discover = index.indexOf("resolvePluginPath('apps')")
  const importApps = index.indexOf('import(`./apps/${file}`)')
  assert.ok(initialize >= 0)
  assert.ok(discover > initialize)
  assert.ok(importApps > discover)
  assert.doesNotMatch(index.slice(0, initialize), /\.\/apps\//)
  assert.equal((index.match(/initializeProductionYunzaiAgent\(/g) ?? []).length, 1)
})

test('Plan 2 bootstrap discards only exact request observations without retaining data', async () => {
  const index = await source('index.js')
  const match = /function createPlan2DiscardingRequestObservationPublisher \(\) \{([\s\S]*?)\n\}/.exec(index)
  assert.notEqual(match, null)
  const body = match?.[1] ?? ''
  assert.match(body, /Object\.freeze/)
  assert.match(body, /parseRequestObservation\(observation\)/)
  assert.doesNotMatch(body, /new Map|new Set|\[\]|\.push\(|redis|fetch|logger|console/)
  assert.match(index, /const requestObservations = createPlan2DiscardingRequestObservationPublisher\(\)/)
  assert.match(index, /requestObservations,/)
})

function inspectProductionTtsSource (file: string, contents: string): void {
  const scriptKind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  const ast = ts.createSourceFile(file, contents, ts.ScriptTarget.Latest, true, scriptKind)
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      /utils\/common\.js$/.test(node.moduleSpecifier.text)) {
      const clause = node.importClause
      assert.equal(clause?.namedBindings !== undefined, false)
      assert.equal(clause?.name?.text === 'generateAudio', false)
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      assert.notEqual(node.expression.text, 'generateAudio')
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
}

test('production bootstrap constructs the TTS port without the legacy event audio adapter', async () => {
  const index = await source('index.js')
  assert.match(index, /createYunzaiTtsReplyPort\(\{ targets: ttsTargets, backend: ttsBackend \}\)/)
  assert.match(index, /synthesizeAudio:\s*async \(event, text, voice, signal\)/)
  assert.match(index, /const result = await tts\.synthesize\(/)
  assert.doesNotMatch(index, /from ['"]\.\/utils\/common\.js['"]/)
})

test('production browser release follows the shared-process low-memory policy', async () => {
  const index = await source('index.js')
  assert.match(index, /releaseBrowserAfterRender\(\{/)
  assert.match(index, /browser:\s*browserHandle/)
  assert.match(index, /createBrowserReleaseLog\(releaseResult\)/)
  assert.match(index, /result === 'closed' \|\| result === 'disconnected'/)
  assert.match(index, /BROWSER_RELEASE_TIMEOUT_MS/)
  assert.match(index, /MAX_PICTURE_RASTER_BYTES/)
  assert.match(index, /boundedScreenshotDpr/)
  assert.match(index, /createBrowserOperationBoundary/)
  assert.match(index, /closePageWithinBoundary/)
  assert.match(index, /Config\.chromeTimeoutMS/)
  assert.doesNotMatch(index, /manager\?\.close\(\)/)
})

test('production model transport is graph-stable and fails closed on configuration drift', async () => {
  const index = await source('index.js')
  const port = /function createProductionModelPort \(\) \{([\s\S]*?)\n\}/.exec(index)?.[1] ?? ''
  assert.match(port, /const selected = resolveOpenAICompatibleModelRuntimeConfig/)
  assert.match(port, /const endpoint = normalizedText\(Config\.openAiBaseUrl/)
  assert.match(port, /const apiKey = normalizedText\(Config\.apiKey/)
  assert.match(port, /const getAdapter = \(\) => \{/)
  assert.match(port, /const current = resolveOpenAICompatibleModelRuntimeConfig\(\{/)
  assert.match(port, /openAiCompatibilityProfile:\s*Config\.openAiCompatibilityProfile/)
  assert.match(port, /current\.configuredProfile !== selected\.configuredProfile/)
  assert.match(port, /normalizedText\(Config\.openAiBaseUrl[^\n]*!== endpoint/)
  assert.match(port, /normalizedText\(Config\.apiKey[^\n]*!== apiKey/)
  assert.match(port, /throw new ModelProviderError/)
  assert.match(port, /new OpenAICompatibleAdapter\(\{/)
  assert.match(port, /endpoint,\s*\n\s*apiKey,/)
  assert.match(port, /profile:\s*selected\.profile/)
  assert.doesNotMatch(port, /if \(adapter !== undefined\) return adapter/)
  assert.match(index, /model:\s*\(\) => normalizedText\(Config\.model/)
})

test('production TTS materializes bounded audio before deleting temporary files', async () => {
  const index = await source('index.js')
  assert.match(index, /boundedResponseBytes\(response, MAX_AUDIO_BYTES\)/)
  assert.match(index, /await fs\.promises\.readFile\(localPath\)/)
  assert.match(index, /kind:\s*'buffer', data/)
  assert.match(index, /runLowMemoryTts/)
  assert.match(index, /MAX_AUDIO_BYTES/)
  assert.match(index, /generateVitsAudio\([^)]*signal/s)
  assert.match(index, /AzureTTS\.generateAudio\([^)]*signal/s)
  assert.match(index, /VoiceVoxTTS\.generateAudio\([^)]*signal/s)
  assert.match(index, /uploadRecord\([^)]*signal/s)
  assert.ok(
    index.indexOf('await fs.promises.readFile(localPath)') <
      index.indexOf('await fs.promises.unlink(temporaryFile)')
  )
})

test('production TTS imports reject the common event adapter but allow lower-level backend methods', async () => {
  const files = [
    'index.js',
    'apps/chat.js',
    'apps/bym.js',
    'src/runtime/runtime-presentation-hooks.ts',
    'src/runtime/production-yunzai-agent.ts',
    'src/runtime/presentation/yunzai-tts-reply-port.ts'
  ]
  for (const file of files) inspectProductionTtsSource(file, await source(file))
  const index = await source('index.js')
  assert.match(index, /AzureTTS\.generateAudio\(/)
  assert.match(index, /VoiceVoxTTS\.generateAudio\(/)
})

test('Presenter modules import no observation contracts and coordinator publishes safe facts only', async () => {
  const presentationFiles = [
    'src/runtime/presentation/reply-presenter.ts',
    'src/runtime/presentation/yunzai-outbound-port.ts',
    'src/runtime/presentation/tts-reply-presentation.ts',
    'src/runtime/picture-reply.ts'
  ]
  for (const file of presentationFiles) {
    const contents = await source(file)
    assert.doesNotMatch(contents, /request-observation|run-observation/)
  }
  const coordinator = await source('src/runtime/request-observation-completion.ts')
  assert.match(coordinator, /finalizeRequestObservation/)
  assert.match(coordinator, /input\.publisher\.publish\(observation\)/)
  assert.doesNotMatch(coordinator, /messageId|targetId|prompt|settings|receipts/)
})
