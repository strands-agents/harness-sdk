import { GeminiDecisionModel } from '@strands-agents/sdk'

async function configurationExample() {
  // --8<-- [start:configuration]
  // Reads GEMINI_API_KEY; defaults to gemini-decision-1
  const decisions = new GeminiDecisionModel()

  const result = await decisions.ask('I was charged twice for order 1182.', {
    urgent: { question: 'Is this urgent?', choices: 'boolean' },
    department: {
      question: 'Which team should handle this?',
      choices: ['billing', 'shipping', 'technical'],
      // On Gemini's scale: the top option needs a probability of at least 0.6
      uncertainty: { minConfidence: 0.6 },
    },
  })
  console.log(result.answers, result.metadata.confidence)
  // --8<-- [end:configuration]
}
