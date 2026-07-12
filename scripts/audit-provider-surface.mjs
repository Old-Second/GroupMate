import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const definitions = [
  ['openaiCompatible', /openai|chat\/completions|openAiBaseUrl/i],
  ['chatgptWeb', /api3|accessToken|refreshToken/i],
  ['bing', /bing|sydney|copilot/i],
  ['claude', /claude/i],
  ['gemini', /gemini|google-generative/i],
  ['qwen', /qwen|通义/i],
  ['chatglm', /chatglm|glm4/i],
  ['xinghuo', /xinghuo|星火/i],
  ['azureOpenai', /azureUrl|azureDeploymentName|@azure\/openai/i]
]

export async function scanProviderSurface (rootUrl) {
  const cwd = fileURLToPath(rootUrl)
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '-z', '*.js', '*.ts', '*.json', '*.md', '*.patch'],
    { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 }
  )
  const paths = stdout.split('\0').filter(path =>
    path &&
    !path.startsWith('server/static/') &&
    !path.startsWith('docs/') &&
    !path.startsWith('test/') &&
    path !== 'AGENTS.md' &&
    path !== 'NOTICE.md'
  )
  const result = definitions.map(([id]) => ({ id, hits: [] }))
  for (const path of paths) {
    const lines = (await readFile(resolve(cwd, path), 'utf8')).split('\n')
    lines.forEach((line, index) => {
      definitions.forEach(([id, pattern], definitionIndex) => {
        if (pattern.test(line)) result[definitionIndex].hits.push({ path, line: index + 1 })
      })
    })
  }
  return result
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await scanProviderSurface(new URL('../', import.meta.url)), null, 2))
}
