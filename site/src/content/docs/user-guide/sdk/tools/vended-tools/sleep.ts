import { Agent } from '@strands-agents/sdk'
import { sleep, makeSleep } from '@strands-agents/sdk/vended-tools/sleep'

// Sleep tool example
async function sleepExample() {
  // --8<-- [start:sleep_example]
  const agent = new Agent({
    tools: [sleep],
  })
  await agent.invoke('Pause for two seconds, then continue.')
  // --8<-- [end:sleep_example]
}

// Sleep tool custom maximum
async function sleepCustomExample() {
  // --8<-- [start:sleep_custom_example]
  const shortSleep = makeSleep({ maxDuration: 5 })
  const agent = new Agent({ tools: [shortSleep] })
  // --8<-- [end:sleep_custom_example]
}
