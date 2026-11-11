import { Agent } from '@strands-agents/sdk'
import { edit } from '@strands-agents/sdk/vended-tools/edit'

// Edit example
async function editExample() {
  // --8<-- [start:edit_example]
  const agent = new Agent({
    tools: [edit],
  })

  await agent.invoke("In /tmp/hello.txt, replace 'world' with 'Strands'.")
  // --8<-- [end:edit_example]
}
