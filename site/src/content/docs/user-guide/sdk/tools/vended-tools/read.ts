import { Agent } from '@strands-agents/sdk'
import { read } from '@strands-agents/sdk/vended-tools/read'

// Read tool example
async function readExample() {
  // --8<-- [start:read_example]
  const agent = new Agent({ tools: [read] })
  await agent.invoke('Read /etc/hosts and summarize what it maps.')
  // --8<-- [end:read_example]
}
