import { Agent } from '@strands-agents/sdk'
import { write } from '@strands-agents/sdk/vended-tools/write'

// Write tool example
async function writeExample() {
  // --8<-- [start:write_example]
  const agent = new Agent({ tools: [write] })
  await agent.invoke("Create /tmp/hello.txt containing 'Hello, Strands!'")
  // --8<-- [end:write_example]
}
