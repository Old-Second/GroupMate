import { Config } from './config.js'
import { generateContextualGreeting } from '../dist/runtime/GreetingContext.js'

/**
 * Sends a proactive greeting. The bounded prompt building and group-context
 * reading live in TypeScript; this module only projects the live configuration.
 */
export async function generateHello (options = {}) {
  return await generateContextualGreeting({
    ...options,
    assistantLabel: Config.assistantLabel,
    helloPrompt: Config.helloPrompt,
    useGroupContext: Config.helloUseGroupContext !== false,
    groupContextLength: Config.groupContextLength
  })
}
