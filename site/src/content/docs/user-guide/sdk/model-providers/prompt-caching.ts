/**
 * TypeScript examples for the prompt caching overview page.
 */

import { Agent, BedrockModel } from '@strands-agents/sdk'

// Turn off implicit caching for an OpenAI model on the Converse API
export async function converseImplicitCachingOff() {
  // --8<-- [start:converse_implicit_caching_off]
  const model = new BedrockModel({
    modelId: 'us.openai.gpt-6-luna',
    // Converse forwards this to the model; with no cache points it caches nothing.
    additionalRequestFields: { prompt_cache_options: { mode: 'explicit' } },
  })

  const agent = new Agent({ model })
  // --8<-- [end:converse_implicit_caching_off]

  await agent.invoke('Hello')
}
