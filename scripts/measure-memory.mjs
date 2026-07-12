import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scenarios = ['node', 'openaiClient', 'idle', 'singleRun', 'twoRun']
const samplesPerScenario = 5
const scenarioPath = fileURLToPath(new URL('./memory-scenario.mjs', import.meta.url))
const projectRoot = fileURLToPath(new URL('../', import.meta.url))

const expectedRequestCounts = {
  node: 0,
  openaiClient: 0,
  idle: 0,
  singleRun: 1,
  twoRun: 2
}
const expectedMaxConcurrency = {
  node: 0,
  openaiClient: 0,
  idle: 0,
  singleRun: 1,
  twoRun: 2
}
const metricNames = [
  'requestCount',
  'maxConcurrentRequests',
  'retainedRssBytes',
  'observedPeakRssBytes',
  'maxRssScale'
]

function validatePositiveInteger (value, name, scenario) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name} for ${scenario}: ${value}`)
  }
}

function validateSample (sample, scenario) {
  if (!sample || typeof sample !== 'object' || Array.isArray(sample)) {
    throw new Error(`Invalid sample for ${scenario}`)
  }
  if (sample.scenario !== scenario) {
    throw new Error(`Scenario mismatch: expected ${scenario}, received ${sample.scenario}`)
  }
  if (sample.requestCount !== expectedRequestCounts[scenario]) {
    throw new Error(`Unexpected request count for ${scenario}: ${sample.requestCount}`)
  }
  if (sample.maxConcurrentRequests !== expectedMaxConcurrency[scenario]) {
    throw new Error(`Unexpected maximum concurrency for ${scenario}: ${sample.maxConcurrentRequests}`)
  }

  validatePositiveInteger(sample.retainedRssBytes, 'retained RSS', scenario)
  validatePositiveInteger(sample.observedPeakRssBytes, 'observed peak RSS', scenario)
  if (sample.observedPeakRssBytes < sample.retainedRssBytes) {
    throw new Error(`Observed peak RSS is below retained RSS for ${scenario}`)
  }
  if (sample.maxRssScale !== 1 && sample.maxRssScale !== 1024) {
    throw new Error(`Invalid max RSS scale for ${scenario}: ${sample.maxRssScale}`)
  }
}

function sampleScenario (scenario) {
  const result = spawnSync(process.execPath, ['--expose-gc', scenarioPath, scenario], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: 5000
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `${scenario} child exited ${result.status}`)
  }

  let sample
  try {
    sample = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`Invalid JSON from ${scenario}: ${error.message}`)
  }
  validateSample(sample, scenario)
  return sample
}

function median (values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

function medianMetrics (samples) {
  return Object.fromEntries(metricNames.map(name => [
    name,
    median(samples.map(sample => sample[name]))
  ]))
}

const samples = {}
const medians = {}
for (const scenario of scenarios) {
  samples[scenario] = []
  for (let index = 0; index < samplesPerScenario; index += 1) {
    samples[scenario].push(sampleScenario(scenario))
  }
  medians[scenario] = medianMetrics(samples[scenario])
}

const deltasFromNode = {
  openaiClientRetainedRssBytes: medians.openaiClient.retainedRssBytes - medians.node.retainedRssBytes,
  idleRetainedRssBytes: medians.idle.retainedRssBytes - medians.node.retainedRssBytes,
  singleRunRetainedRssBytes: medians.singleRun.retainedRssBytes - medians.node.retainedRssBytes,
  twoRunRetainedRssBytes: medians.twoRun.retainedRssBytes - medians.node.retainedRssBytes,
  twoRunObservedPeakRssBytes: medians.twoRun.observedPeakRssBytes - medians.node.observedPeakRssBytes
}

process.stdout.write(JSON.stringify({
  node: process.version,
  samplesPerScenario,
  samples,
  medians,
  deltasFromNode
}, null, 2))
