import { Agent } from '@strands-agents/sdk'
import { stop } from '@strands-agents/sdk/vended-tools/stop'

// Stop tool example
async function stopExample() {
  // --8<-- [start:stop_example]
  const agent = new Agent({
    tools: [stop],
    systemPrompt: 'Complete the task. Call stop with a short summary when you are done.',
  })
  await agent.invoke('Summarize the changes in ./CHANGELOG.md')
  // --8<-- [end:stop_example]
}
