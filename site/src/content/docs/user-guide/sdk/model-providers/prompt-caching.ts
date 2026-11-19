/**
 * TypeScript examples for the prompt caching overview page.
 */
import { Agent } from '@strands-agents/sdk'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'
import { OpenAIModel } from '@strands-agents/sdk/models/openai'
import { ContextInjector } from '@strands-agents/sdk/vended-plugins/context-injector'

async function enableCaching() {
  // --8<-- [start:enable]
  const model = new BedrockModel({
    modelId: 'global.anthropic.claude-sonnet-4-6',
    cacheConfig: { strategy: 'auto' },
  })

  const agent = new Agent({ model, systemPrompt: 'You are a support agent for Acme.' })
  await agent.invoke('How do I reset my password?')
  // --8<-- [end:enable]
}

async function responsesOnBedrock() {
  // --8<-- [start:responses]
  // GPT-5.6 and later take cache points on the Responses API, not on Converse
  const model = new OpenAIModel({
    modelId: 'openai.gpt-6-luna',
    bedrockMantleConfig: { region: 'us-east-1' },
    cacheConfig: { strategy: 'auto' },
  })

  const agent = new Agent({ model })
  await agent.invoke('Summarize the open incidents.')
  // --8<-- [end:responses]
}

async function injectOncePerTurn() {
  // --8<-- [start:injector]
  // Inject once per user turn, not on every model call in the tool loop
  const today = new ContextInjector({
    trigger: 'userTurn',
    renderContent: async () => `Today is ${new Date().toDateString()}.`,
  })

  const agent = new Agent({
    model: new BedrockModel({
      modelId: 'us.openai.gpt-6-luna',
      cacheConfig: { strategy: 'auto' },
    }),
    plugins: [today],
  })
  await agent.invoke('What is due this week?')
  // --8<-- [end:injector]
}

async function checkCaching() {
  // --8<-- [start:check]
  const agent = new Agent({
    model: new BedrockModel({
      modelId: 'global.anthropic.claude-sonnet-4-6',
      cacheConfig: { strategy: 'auto' },
    }),
    systemPrompt: 'You are a support agent for Acme. '.repeat(200),
  })

  await agent.invoke('How do I reset my password?')
  const result = await agent.invoke('And how do I enable two-factor sign-in?')
  const usage = result.metrics?.accumulatedUsage
  console.log(`read: ${usage?.cacheReadInputTokens ?? 0}`)
  console.log(`written: ${usage?.cacheWriteInputTokens ?? 0}`)
  // --8<-- [end:check]
}

void enableCaching
void responsesOnBedrock
void injectOncePerTurn
void checkCaching
