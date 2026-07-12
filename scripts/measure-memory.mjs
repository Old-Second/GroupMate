import { spawnSync } from 'node:child_process'

const scenarios = {
  node: '',
  openaiClient: "await import('./utils/openai/chatgpt-api.js')"
}

function sample (statement) {
  const program = `${statement}; if (global.gc) global.gc(); setTimeout(() => console.log(JSON.stringify(process.memoryUsage())), 25)`
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '--eval', program], {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    timeout: 5000
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || `child exited ${result.status}`)
  return JSON.parse(result.stdout.trim()).rss
}

function median (values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const output = {}
for (const [name, statement] of Object.entries(scenarios)) {
  output[name] = median(Array.from({ length: 5 }, () => sample(statement)))
}
output.openaiClientDelta = output.openaiClient - output.node
console.log(JSON.stringify({ node: process.version, rssBytes: output }, null, 2))
