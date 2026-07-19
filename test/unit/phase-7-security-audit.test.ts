import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import {
  auditPhase7SecurityBoundaries,
  type Phase7SecurityAuditOptions
} from '../../src/verification/phase-7-security-audit.js'

const root = process.cwd()

async function source (relativePath: string): Promise<string> {
  return await readFile(path.join(root, relativePath), 'utf8')
}

function fixture (
  relativePath: string,
  value: string,
  input: Partial<Phase7SecurityAuditOptions> = {}
): Phase7SecurityAuditOptions {
  return {
    sourceOverrides: Object.freeze({ [relativePath]: value }),
    skipSourceDistCheck: true,
    skipGitDiffCheck: true,
    ...input
  }
}

test('Phase 7 security audit composes Phase 6 with exact empty incremental findings', async () => {
  const result = await auditPhase7SecurityBoundaries(root, {
    skipSourceDistCheck: true,
    skipGitDiffCheck: true
  })

  assert.deepEqual(result, {
    forbiddenFields: [],
    unsafeLoggerCalls: [],
    forbiddenTraceRedisCommands: [],
    dynamicMetricDefinitions: [],
    sourceDistMismatches: [],
    forbiddenProductionEdges: [],
    forbiddenRedactedBodyFields: [],
    forbiddenProviderIsolationLeaks: [],
    forbiddenContextArtifactLeaks: [],
    invalidContentJournalBoundaries: [],
    forbiddenPhase7Edges: [],
    passed: true
  })
})

test('Phase 7 security audit preserves every Phase 6 finding', async () => {
  const tracePath = 'src/runtime/observability/trace-record.ts'
  const result = await auditPhase7SecurityBoundaries(root, fixture(
    tracePath,
    `${await source(tracePath)}\ninterface UnsafeTrace { readonly text: string }\n`
  ))

  assert.deepEqual(result.forbiddenFields, [`${tracePath}:text`])
  assert.equal(result.passed, false)
})

test('redacted observation and diagnostic surfaces reject provider isolation identifiers', async () => {
  const observationPath = 'src/runtime/observability/trace-record.ts'
  const userId = await auditPhase7SecurityBoundaries(root, fixture(
    observationPath,
    `${await source(observationPath)}\ninterface UnsafeTrace { readonly user_id: string }\n`
  ))
  assert.deepEqual(userId.forbiddenProviderIsolationLeaks, [
    `${observationPath}:user_id`
  ])

  const diagnosticPath = 'src/runtime/observability/owner-diagnostics.ts'
  const metadata = await auditPhase7SecurityBoundaries(root, fixture(
    diagnosticPath,
    `${await source(diagnosticPath)}\nconst unsafe = { cacheIsolationId: 'gm_g_fixture' }\n`
  ))
  assert.deepEqual(metadata.forbiddenProviderIsolationLeaks, [
    `${diagnosticPath}:cache_isolation_id`,
    `${diagnosticPath}:derived_isolation_id`
  ])
  assert.equal(metadata.passed, false)
})

test('all redacted diagnostic surfaces reject persisted body and identity fields', async () => {
  const diagnosticPath = 'src/runtime/observability/owner-diagnostics.ts'
  const result = await auditPhase7SecurityBoundaries(root, fixture(
    diagnosticPath,
    `${await source(diagnosticPath)}\ninterface UnsafeDiagnostic { readonly content: string; readonly messages: readonly string[]; readonly groupId: string }\n`
  ))

  assert.deepEqual(result.forbiddenRedactedBodyFields, [
    `${diagnosticPath}:content`,
    `${diagnosticPath}:groupId`,
    `${diagnosticPath}:messages`
  ])
  assert.equal(result.passed, false)
})

test('redacted diagnostics reject raw text, credentials, object spread and direct returns', async () => {
  const diagnosticPath = 'src/runtime/observability/owner-diagnostics.ts'
  const result = await auditPhase7SecurityBoundaries(root, fixture(
    diagnosticPath,
    `${await source(diagnosticPath)}\ninterface UnsafeCredential { readonly token: string }\nfunction unsafe (request: unknown) { const projected = { text: request }; const spread = { ...request }; if (projected) return request; return spread }\n`
  ))

  assert.deepEqual(result.forbiddenRedactedBodyFields, [
    `${diagnosticPath}:raw_return`,
    `${diagnosticPath}:raw_spread`,
    `${diagnosticPath}:text`,
    `${diagnosticPath}:token`
  ])
  assert.equal(result.passed, false)
})

test('redacted observation and diagnostic surfaces reject context artifact bodies', async () => {
  const tracePath = 'src/agent/run/run-trace.ts'
  const result = await auditPhase7SecurityBoundaries(root, fixture(
    tracePath,
    `${await source(tracePath)}\nfunction unsafe (artifact: ContextArtifactV1) { return artifact.content }\n`
  ))

  assert.deepEqual(result.forbiddenContextArtifactLeaks, [
    `${tracePath}:artifact_content_access`,
    `${tracePath}:artifact_value_type`
  ])
  assert.equal(result.passed, false)
})

test('all observability policy files and content journal sinks reject isolation material', async () => {
  const policyPath = 'src/runtime/observability/trace-policy.ts'
  const policy = await auditPhase7SecurityBoundaries(root, fixture(
    policyPath,
    `${await source(policyPath)}\nfunction unsafe (artifact: ContextArtifactV1) { return artifact.content }\n`
  ))
  assert.deepEqual(policy.forbiddenContextArtifactLeaks, [
    `${policyPath}:artifact_content_access`,
    `${policyPath}:artifact_value_type`
  ])

  const journalPath = 'src/runtime/logging/groupmate-disk-log.ts'
  const journal = await auditPhase7SecurityBoundaries(root, fixture(
    journalPath,
    `${await source(journalPath)}\ninterface UnsafeJournal { readonly user_id: string }\n`
  ))
  assert.deepEqual(journal.forbiddenProviderIsolationLeaks, [
    `${journalPath}:user_id`
  ])
  assert.equal(journal.passed, false)
})

test('full content journal retains business messages but strips provider metadata', async () => {
  const journalPath = 'src/agent/run/run-content-journal.ts'
  const current = await source(journalPath)
  const strippedMessages = await auditPhase7SecurityBoundaries(root, fixture(
    journalPath,
    current.replace('messages: request.messages', 'messages: Object.freeze([])')
  ))
  assert.deepEqual(strippedMessages.invalidContentJournalBoundaries, [
    `${journalPath}:complete_model_messages`
  ])

  const metadataIncluded = await auditPhase7SecurityBoundaries(root, fixture(
    journalPath,
    current.replace(
      "export type JournalModelRequest = Omit<ModelRequest, 'metadata'>",
      'export type JournalModelRequest = ModelRequest'
    )
  ))
  assert.deepEqual(metadataIncluded.invalidContentJournalBoundaries, [
    `${journalPath}:provider_metadata_projection`
  ])
  assert.equal(metadataIncluded.passed, false)
})

test('Phase 7 verification script remains a static one-import one-main shell', async () => {
  const scriptPath = 'scripts/verify-phase-7.mjs'
  const result = await auditPhase7SecurityBoundaries(root, fixture(
    scriptPath,
    "import { main } from '../dist/verification/phase-7-verification.js'\nif (process.env.X) throw new Error('x')\nawait main()\n"
  ))

  assert.deepEqual(result.forbiddenPhase7Edges, [`${scriptPath}:not_thin`])
  assert.equal(result.passed, false)
})

test('generic context code stays provider-neutral and standard metadata stays empty', async () => {
  const plannerPath = 'src/agent/context/context-planner.ts'
  const providerBranch = await auditPhase7SecurityBoundaries(root, fixture(
    plannerPath,
    `${await source(plannerPath)}\nimport { deepSeekCompatibilityProfile } from '../model/deepseek-compatibility-profile.js'\n`
  ))
  assert.deepEqual(providerBranch.forbiddenPhase7Edges, [
    `${plannerPath}:provider_specific_context`
  ])

  const standardPath = 'src/agent/model/standard-openai-profile.ts'
  const standard = await auditPhase7SecurityBoundaries(root, fixture(
    standardPath,
    (await source(standardPath)).replace(
      'encodeRequestMetadata: () => EMPTY_OBJECT',
      "encodeRequestMetadata: () => Object.freeze({ user_id: 'unsafe' })"
    )
  ))
  assert.deepEqual(standard.forbiddenPhase7Edges, [
    `${standardPath}:standard_metadata_neutrality`
  ])
})

test('all Phase 7 resource and verification scripts remain thin shells', async () => {
  const scriptPath = 'scripts/measure-phase-7-resources.mjs'
  const result = await auditPhase7SecurityBoundaries(root, fixture(
    scriptPath,
    "import { main } from '../dist/verification/phase-7-resource-report.js'\nif (process.env.X) throw new Error('x')\nawait main()\n"
  ))
  assert.deepEqual(result.forbiddenPhase7Edges, [`${scriptPath}:not_thin`])
})
