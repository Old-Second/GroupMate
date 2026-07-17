import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  auditPhase6SecurityBoundaries,
  type Phase6SecurityAuditOptions
} from '../../src/verification/phase-6-security-audit.js'

const root = process.cwd()

async function source (relativePath: string): Promise<string> {
  return await readFile(path.join(root, relativePath), 'utf8')
}

function fixture (
  relativePath: string,
  value: string,
  input: Partial<Phase6SecurityAuditOptions> = {}
): Phase6SecurityAuditOptions {
  return {
    sourceOverrides: Object.freeze({ [relativePath]: value }),
    skipSourceDistCheck: true,
    skipGitDiffCheck: true,
    ...input
  }
}

test('Phase 6 security audit passes the built project with exact empty findings', async () => {
  const result = await auditPhase6SecurityBoundaries(root)

  assert.deepEqual(result, {
    forbiddenFields: [],
    unsafeLoggerCalls: [],
    forbiddenTraceRedisCommands: [],
    dynamicMetricDefinitions: [],
    sourceDistMismatches: [],
    forbiddenProductionEdges: [],
    passed: true
  })
})

test('security audit rejects forbidden trace fields and direct Error logging', async () => {
  const tracePath = 'src/runtime/observability/trace-record.ts'
  const forbidden = await auditPhase6SecurityBoundaries(root, fixture(
    tracePath,
    `${await source(tracePath)}\ninterface UnsafeTrace { readonly text: string }\n`
  ))
  assert.deepEqual(forbidden.forbiddenFields, [`${tracePath}:text`])
  assert.equal(forbidden.passed, false)

  const loggerPath = 'src/runtime/observability/owner-diagnostics.ts'
  const logger = await auditPhase6SecurityBoundaries(root, fixture(
    loggerPath,
    `${await source(loggerPath)}\nfunction unsafe (logger: any, error: Error) { logger.error(error) }\n`
  ))
  assert.deepEqual(logger.unsafeLoggerCalls, [`${loggerPath}:direct_error`])
  assert.equal(logger.passed, false)
})

test('security audit rejects trace-wide Redis commands and dynamic metric identity', async () => {
  const redisPath = 'src/runtime/observability/redis-trace-store.ts'
  const redis = await auditPhase6SecurityBoundaries(root, fixture(
    redisPath,
    `${await source(redisPath)}\nconst unsafeRedis = "redis.call('SCAN', '0')"\n`
  ))
  assert.deepEqual(redis.forbiddenTraceRedisCommands, [`${redisPath}:SCAN`])

  const metricsPath = 'src/runtime/observability/metrics-registry.ts'
  const metrics = await auditPhase6SecurityBoundaries(root, fixture(
    metricsPath,
    `${await source(metricsPath)}\nconst unsafeMetric = \`groupmate.${'${name}'}\`\n`
  ))
  assert.deepEqual(metrics.dynamicMetricDefinitions, [`${metricsPath}:dynamic_name`])
  assert.equal(metrics.passed, false)
})

test('security audit freezes all 14 instruments and their label names', async () => {
  const metricsPath = 'src/runtime/observability/metrics-registry.ts'
  const current = await source(metricsPath)
  const instrument = await auditPhase6SecurityBoundaries(root, fixture(
    metricsPath,
    current.replace(
      "  | 'groupmate.observation.failures'",
      "  | 'groupmate.observation.failurez'"
    )
  ))
  assert.ok(instrument.dynamicMetricDefinitions.includes(`${metricsPath}:instrument_set`))
  assert.ok(instrument.dynamicMetricDefinitions.includes(
    `${metricsPath}:unknown:groupmate.observation.failurez`
  ))

  const labels = await auditPhase6SecurityBoundaries(root, fixture(
    metricsPath,
    current.replace(
      "'groupmate.agent.runs': Object.freeze(['outcome', 'completion_kind', 'error_code'])",
      "'groupmate.agent.runs': Object.freeze(['outcome', 'completion_kind'])"
    )
  ))
  assert.ok(labels.dynamicMetricDefinitions.includes(
    `${metricsPath}:labels:groupmate.agent.runs`
  ))
  assert.equal(labels.passed, false)
})

test('security audit rejects prefix lookup, raw Hub events and legacy presentation edges', async () => {
  const ownerPath = 'src/runtime/observability/owner-diagnostics.ts'
  const owner = (await source(ownerPath)).replace(
    'RUN_REF_PATTERN.test(input.runRef)',
    "input.runRef.startsWith('a')"
  )
  const prefix = await auditPhase6SecurityBoundaries(root, fixture(ownerPath, owner))
  assert.ok(prefix.forbiddenProductionEdges.includes(`${ownerPath}:exact_run_ref`))

  const hubPath = 'src/runtime/observability/observation-hub.ts'
  const hub = await auditPhase6SecurityBoundaries(root, fixture(
    hubPath,
    `${await source(hubPath)}\ntype UnsafeHubEvent = AgentEvent | ToolAuditEvent\n`
  ))
  assert.ok(hub.forbiddenProductionEdges.includes(`${hubPath}:raw_event_edge`))

  const chatPath = 'apps/chat.js'
  const chat = await auditPhase6SecurityBoundaries(root, fixture(
    chatPath,
    `${await source(chatPath)}\nvoid this.reply('legacy')\n`
  ))
  assert.ok(chat.forbiddenProductionEdges.includes(`${chatPath}:legacy_presentation`))
})

test('security audit freezes four facts, diagnostics authorization and presenter imports', async () => {
  const observationPath = 'src/runtime/observability/observation-event.ts'
  const observation = await auditPhase6SecurityBoundaries(root, fixture(
    observationPath,
    (await source(observationPath)).replace(
      "| { readonly schemaVersion: 1; readonly type: 'presentation'; readonly value: PresentationObservationV1 }",
      "| { readonly schemaVersion: 1; readonly type: 'combined'; readonly value: PresentationObservationV1 }"
    )
  ))
  assert.ok(observation.forbiddenProductionEdges.includes(`${observationPath}:fact_union`))

  const diagnosticsPath = 'apps/diagnostics.js'
  const diagnostics = await auditPhase6SecurityBoundaries(root, fixture(
    diagnosticsPath,
    (await source(diagnosticsPath)).replace("permission: 'master'", "permission: 'all'")
  ))
  assert.ok(diagnostics.forbiddenProductionEdges.includes(
    `${diagnosticsPath}:authorization_projection`
  ))

  const productionPath = 'src/runtime/production-yunzai-agent.ts'
  const production = await auditPhase6SecurityBoundaries(root, fixture(
    productionPath,
    `${await source(productionPath)}\nimport '../runtime/legacy-presenter.js'\n`
  ))
  assert.ok(production.forbiddenProductionEdges.includes(
    `${productionPath}:legacy_presenter_import`
  ))
  assert.equal(production.passed, false)
})

test('security audit rejects auth-after-read, non-thin scripts and source/dist drift', async () => {
  const ownerPath = 'src/runtime/observability/owner-diagnostics.ts'
  const owner = (await source(ownerPath)).replace(
    'if (!input.authorized) return this.#finish(\'inspect\'',
    'void this.#traceStore.load(input.runRef)\n    if (!input.authorized) return this.#finish(\'inspect\''
  )
  const auth = await auditPhase6SecurityBoundaries(root, fixture(ownerPath, owner))
  assert.ok(auth.forbiddenProductionEdges.includes(`${ownerPath}:inspect_auth_order`))

  const scriptPath = 'scripts/verify-phase-6.mjs'
  const script = await auditPhase6SecurityBoundaries(root, fixture(
    scriptPath,
    "import { main } from '../dist/verification/phase-6-verification.js'\nif (process.env.X) throw new Error('x')\nawait main()\n"
  ))
  assert.ok(script.forbiddenProductionEdges.includes(`${scriptPath}:not_thin`))

  const distPath = 'dist/runtime/observability/trace-record.js'
  const mismatch = await auditPhase6SecurityBoundaries(root, {
    sourceOverrides: Object.freeze({ [distPath]: 'export const drift = true\n' }),
    skipGitDiffCheck: true
  })
  assert.ok(mismatch.sourceDistMismatches.includes(`${distPath}:content`))
  assert.equal(mismatch.passed, false)
})

test('security audit treats a server static diff as a forbidden production edge', async () => {
  const result = await auditPhase6SecurityBoundaries(root, {
    skipSourceDistCheck: true,
    skipGitDiffCheck: true,
    serverStaticChanged: true
  })
  assert.ok(result.forbiddenProductionEdges.includes('server/static:changed'))
  assert.equal(result.passed, false)
})
