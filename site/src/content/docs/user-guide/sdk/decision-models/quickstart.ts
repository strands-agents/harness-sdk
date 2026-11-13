import { LLMDecisionModel, Uncertain } from '@strands-agents/sdk'

async function askExample() {
  // --8<-- [start:ask]
  const message = 'I was charged twice for order 1182. Please refund one charge today.'

  const decisions = new LLMDecisionModel()
  const result = await decisions.ask(message, {
    urgent: {
      question: 'Does the customer need help today?',
      choices: 'boolean',
    },
    team: {
      question: 'Which team should handle this message?',
      choices: ['billing', 'shipping', 'technical'],
    },
  })
  console.log(result.answers)

  // Typical output:
  // { urgent: true, team: 'billing' }
  // --8<-- [end:ask]
}

async function uncertainExample() {
  // --8<-- [start:uncertain]
  const message = 'I was charged twice for order 1182. Please refund one charge today.'

  const decisions = new LLMDecisionModel()
  const result = await decisions.ask(message, {
    plan: {
      question: 'Which plan is the customer on?',
      choices: ['free', 'pro', 'enterprise'],
    },
  })
  const plan = result.answers.plan
  if (plan instanceof Uncertain) {
    console.log(`Unknown plan: ${plan.reason}`)
  } else {
    console.log(`Plan: ${plan}`)
  }

  // Typical output:
  // Unknown plan: The message does not mention which plan the customer is on.
  // --8<-- [end:uncertain]
}
