import { Agent, LLMDecisionModel, tool } from '@strands-agents/sdk'
import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'
import { z } from 'zod'

async function toolExample() {
  // --8<-- [start:tool]
  const decisions = new LLMDecisionModel()

  const routeMessage = tool({
    name: 'route_message',
    description: 'Send a customer message to the team that handles it.',
    inputSchema: z.object({ message: z.string() }),
    callback: async ({ message }, context) => {
      const result = await decisions.ask(
        message,
        {
          team: {
            question: 'Which team should handle this message?',
            choices: ['billing', 'shipping', 'technical'],
            uncertainty: false,
          },
        },
        { invocationContext: context?.invocationContext }
      )
      return `Routed to ${result.answers.team}`
    },
  })

  const agent = new Agent({ tools: [routeMessage] })
  const result = await agent.invoke('Route this message: my package never arrived.')
  console.log(result.invocationContext?.usage)

  // Typical output:
  // { turnsTaken: 2, inputTokens: 2154, outputTokens: 142, totalTokens: 2296 }
  // --8<-- [end:tool]
}

async function approvalExample() {
  // --8<-- [start:approval]
  const agent = new Agent({
    interventions: [
      new HumanInTheLoop({ classifier: { decisionModel: new LLMDecisionModel() } }),
    ],
  })
  // --8<-- [end:approval]
}
