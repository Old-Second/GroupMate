const baselineRssBytes = process.memoryUsage().rss
const { runPhase5MemoryScenario } = await import(
  '../dist/verification/phase-5-memory-scenario.js'
)
const sample = await runPhase5MemoryScenario(process.argv[2], { baselineRssBytes })
process.stdout.write(JSON.stringify(sample))
