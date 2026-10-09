import { BedrockModel, LLMDecisionModel } from '@strands-agents/sdk'

async function main() {
  const decision = new LLMDecisionModel(new BedrockModel())

  const questions = {
    color: {
      instructions: 'What color is the fruit?',
      choices: ['red', 'yellow', 'blue'] as const,
    },
    isHeavy: {
      instructions: 'Is the thing talked about heavy?',
      choices: 'boolean' as const,
      uncertainOptions: {
        allow: false,
      },
    },
  }

  const prompts = [
    'The fruit is an banana.',
    'There is a round heavy object on the table.',
  ]

  for (const prompt of prompts) {
    console.log(`\n--- ${prompt} ---`)
    const result = await decision.ask(prompt, questions)
    console.log('color:  ', String(result.answers.color))
    console.log('isHeavy:', String(result.answers.isHeavy))
    console.log('usage:  ', result.usage)
    console.log('latency:', `${result.metadata.latencyMs}ms`)
  }
}

await main().catch(console.error)
