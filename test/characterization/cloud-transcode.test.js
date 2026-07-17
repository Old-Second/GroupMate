import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { buildGuobaSchemas } from '../../dist/runtime/guoba-schema.js'

const projectUrl = new URL('../../', import.meta.url)

test('cloud transcoding is disabled unless the user explicitly configures it', async () => {
  const configSource = await readFile(new URL('utils/config.js', projectUrl), 'utf8')
  const exampleConfig = JSON.parse(
    await readFile(new URL('config/config.example.json', projectUrl), 'utf8')
  )
  const cloudTranscodeSchema = buildGuobaSchemas({
    vitsRoleOptions: [],
    voicevoxRoleOptions: [],
    azureRoleOptions: []
  }).find(item => item.field === 'cloudTranscode')

  assert.match(configSource, /cloudTranscode:\s*''/)
  assert.equal(exampleConfig.cloudTranscode, '')
  assert.match(cloudTranscodeSchema.bottomHelpMessage, /留空时直接交给当前 QQ 适配器处理/)
})

test('both cloud transcode uploads use the TypeScript timeout boundary', async () => {
  const source = await readFile(new URL('utils/uploadRecord.js', projectUrl), 'utf8')

  assert.match(
    source,
    /import\s*\{\s*withCloudTranscodeTimeout\s*\}\s*from '\.\.\/dist\/runtime\/cloud-transcode\.js'/
  )
  assert.equal(
    source.match(/withCloudTranscodeTimeout\(timeoutSignal => fetch\(`/g)?.length,
    2
  )
  assert.equal(
    source.match(/method:\s*'POST',[\s\S]{0,200}signal:\s*combinedSignal\(signal, timeoutSignal\)/g)?.length,
    2
  )
  assert.doesNotMatch(source, /resultres\.(?:arrayBuffer|text)\(\)/)
})
