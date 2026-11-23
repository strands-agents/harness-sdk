import { OpenAIDecisionModel } from '@strands-agents/sdk'

export async function configurationExample() {
  // --8<-- [start:configuration]
  // Reads OPENAI_API_KEY; defaults to gpt-6-luna
  const decisions = new OpenAIDecisionModel()

  const result = await decisions.ask('I was charged twice for order 1182.', {
    urgent: { question: 'Is this urgent?', choices: 'boolean' },
    department: {
      question: 'Which team should handle this?',
      choices: ['billing', 'shipping', 'technical'],
      uncertainty: { minConfidence: 0.6 },
    },
  })
  console.log(result.answers, result.metadata.confidence)
  // --8<-- [end:configuration]
}
