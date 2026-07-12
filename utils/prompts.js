import _ from 'lodash'
import fs from 'fs'
import path from 'node:path'
import { mkdirs } from './common.js'
import { resolvePluginPath } from '../dist/runtime/plugin-context.js'

const promptsDirectory = resolvePluginPath('prompts')

export function readPrompts () {
  let prompts = []
  if (fs.existsSync(promptsDirectory)) {
    const files = fs.readdirSync(promptsDirectory)
    const txtFiles = files.filter(file => file.endsWith('.txt'))
    txtFiles.forEach(txtFile => {
      let name = _.trimEnd(txtFile, '.txt')
      const content = fs.readFileSync(path.join(promptsDirectory, txtFile), 'utf8')
      let example = []
      try {
        const examplePath = path.join(promptsDirectory, `${name}_example.json`)
        if (fs.existsSync(examplePath)) {
          example = fs.readFileSync(examplePath, 'utf8')
          example = JSON.parse(example)
        }
      } catch (err) {
        logger.debug(err)
      }
      prompts.push({
        name,
        content,
        example
      })
    })
  }
  return prompts
}

export function getPromptByName (name) {
  if (!name) {
    return null
  }
  let prompts = readPrompts()
  let hits = prompts.filter(p => p.name.trim() === name.trim())
  if (hits && hits.length > 0) {
    return hits[0]
  } else {
    return null
  }
}

export function saveOnePrompt (name, content, examples) {
  mkdirs(promptsDirectory)
  let filePath = path.join(promptsDirectory, `${name}.txt`)
  fs.writeFileSync(filePath, content)
  if (examples) {
    let examplePath = path.join(promptsDirectory, `${name}_example.json`)
    fs.writeFileSync(examplePath, JSON.stringify(examples))
  }
}

export function deleteOnePrompt (name) {
  mkdirs(promptsDirectory)
  let filePath = path.join(promptsDirectory, `${name}.txt`)
  fs.unlinkSync(filePath)
  try {
    let examplePath = path.join(promptsDirectory, `${name}_example.json`)
    fs.unlinkSync(examplePath)
  } catch (err) {}
}
