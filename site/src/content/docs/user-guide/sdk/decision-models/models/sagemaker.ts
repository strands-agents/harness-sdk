import { SageMakerDecisionModel } from '@strands-agents/sdk/decisions/sagemaker'

async function configurationExample() {
  // --8<-- [start:configuration]
  const message = 'I was charged twice for order 1182. Please refund one charge today.'

  const decisions = new SageMakerDecisionModel({
    endpointName: 'strands-decider-2b-qwen3-5-v1-2610',
    region: 'us-east-1',
  })
  const { answers, metadata } = await decisions.ask(message, {
    urgent: {
      question: 'Does the customer need help today?',
      choices: 'boolean',
    },
    team: {
      question: 'Which team should handle this message?',
      choices: ['billing', 'shipping', 'technical'],
    },
  })
  console.log(answers.urgent, metadata.confidence?.urgent.toFixed(2))
  console.log(answers.team, metadata.confidence?.team.toFixed(2))

  // Typical output:
  // true 0.90
  // billing 1.00
  // --8<-- [end:configuration]
}

async function timeoutExample() {
  // --8<-- [start:timeout]
  const decisions = new SageMakerDecisionModel({
    endpointName: 'strands-decider-2b-qwen3-5-v1-2610',
    region: 'us-east-1',
  })
  const { answers } = await decisions.ask(
    'My package never arrived.',
    {
      team: {
        question: 'Which team should handle this message?',
        choices: ['billing', 'shipping', 'technical'],
      },
    },
    // Give up on the decision after five seconds
    { cancelSignal: AbortSignal.timeout(5000) }
  )
  console.log(answers.team)

  // Typical output:
  // shipping
  // --8<-- [end:timeout]
}
