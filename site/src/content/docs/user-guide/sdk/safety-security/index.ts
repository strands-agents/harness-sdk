import { Agent, BedrockModel } from '@strands-agents/sdk'

async function guardrailAgent() {
  // --8<-- [start:guardrail_agent]
  // The guardrail screens every prompt and response; blocked content is redacted
  const model = new BedrockModel({
    guardrailConfig: {
      guardrailIdentifier: 'your-guardrail-id',
      guardrailVersion: '1',
    },
  })

  const agent = new Agent({ model })
  await agent.invoke('Summarize our refund policy for a customer.')
  // --8<-- [end:guardrail_agent]
}
