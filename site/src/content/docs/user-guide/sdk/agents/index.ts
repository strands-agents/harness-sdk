import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'

async function agentAnatomy() {
  // --8<-- [start:agent_anatomy]
  const wordCount = tool({
    name: 'word_count',
    description: 'Count the words in a piece of text.',
    inputSchema: z.object({ text: z.string() }),
    callback: (input) => `${input.text.split(/\s+/).length} words`,
  })

  const agent = new Agent({
    systemPrompt: 'You are a concise writing assistant.',
    tools: [wordCount],
  })
  await agent.invoke('How many words are in this sentence?')
  // --8<-- [end:agent_anatomy]
}
