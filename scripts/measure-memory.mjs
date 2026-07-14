import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  PHASE_5_MEMORY_SCENARIOS
} from '../dist/verification/phase-5-memory-scenario.js'
import {
  PHASE_5_MEMORY_SAMPLES,
  buildPhase5MemoryReport,
  validatePhase5MemorySample
} from '../dist/verification/phase-5-memory-report.js'

const scenarioPath = fileURLToPath(new URL('./memory-scenario.mjs', import.meta.url))
const projectRoot = fileURLToPath(new URL('../', import.meta.url))

function sampleScenario (scenario) {
  const result = spawnSync(process.execPath, ['--expose-gc', scenarioPath, scenario], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: 10_000
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${scenario} child exited ${result.status}`)
  }
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error(`Invalid JSON from ${scenario}`)
  }
  return validatePhase5MemorySample(parsed, scenario)
}

const samples = Object.fromEntries(PHASE_5_MEMORY_SCENARIOS.map(scenario => [
  scenario,
  Array.from({ length: PHASE_5_MEMORY_SAMPLES }, () => sampleScenario(scenario))
]))
const report = buildPhase5MemoryReport(samples)
process.stdout.write(`${JSON.stringify({ node: process.version, ...report }, null, 2)}\n`)
if (!report.passed) process.exitCode = 1
