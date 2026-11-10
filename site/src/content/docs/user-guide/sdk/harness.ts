import { Agent } from '@strands-agents/sdk'

async function minimalAgent() {
  // --8<-- [start:minimal_agent]
  const agent = new Agent()
  const result = await agent.invoke('Explain the agent loop in one sentence.')
  console.log(result.lastMessage)
  // --8<-- [end:minimal_agent]
}
