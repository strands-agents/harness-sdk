import { Agent, InterruptResponseContent } from '@strands-agents/sdk'
import {
  handoffToUser,
  HANDOFF_INTERRUPT_NAME,
} from '@strands-agents/sdk/vended-tools/handoff-to-user'

// Handoff to user example
async function handoffToUserExample() {
  // --8<-- [start:handoff_to_user_example]
  const agent = new Agent({
    tools: [handoffToUser],
    systemPrompt:
      'Before deleting any files, call handoff_to_user to confirm with the user.',
  })

  let result = await agent.invoke('Delete all .tmp files in /workspace.')
  const interrupt = result.interrupts?.find((i) => i.name === HANDOFF_INTERRUPT_NAME)
  if (interrupt) {
    console.log(interrupt.reason)
    result = await agent.invoke([
      new InterruptResponseContent({ interruptId: interrupt.id, response: 'confirmed' }),
    ])
  }
  // --8<-- [end:handoff_to_user_example]
}
