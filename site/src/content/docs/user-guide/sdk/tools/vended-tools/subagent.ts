import { Agent } from '@strands-agents/sdk'
import { Choice, Option, Preset } from '@strands-agents/sdk/multiagent'
import { subagent, makeSubagent } from '@strands-agents/sdk/vended-tools/subagent'

// Subagent tool example
async function subagentExample() {
  // --8<-- [start:subagent_example]
  const agent = new Agent({
    systemPrompt: 'You are a manager.',
    tools: [subagent],
  })
  await agent.invoke('Research the latest TypeScript 5.x features and summarize them.')
  // --8<-- [end:subagent_example]
}

// Subagent tool with full control
async function subagentCustomExample() {
  // --8<-- [start:subagent_custom_example]
  const subagent = makeSubagent({
    presets: {
      researcher: new Preset({
        instructions: 'You research topics thoroughly.',
        description: 'deep research on a topic',
      }),
      reviewer: new Preset({
        instructions: 'You review code for correctness and style.',
        description: 'code review',
      }),
    },
    model: new Choice([
      new Option('fast', 'global.anthropic.claude-sonnet-4-6', 'quick tasks'),
      new Option('deep', 'global.anthropic.claude-opus-4-6-v1', 'hard problems'),
    ]),
    context: new Choice(['none', 'all', 'no_tools']),
    tools: new Choice(['read', 'shell', 'write'], true),
    maxDepth: 3,
  })
  const agent = new Agent({ tools: [subagent] })
  await agent.invoke('Review the changes in src/main.ts for correctness.')
  // --8<-- [end:subagent_custom_example]
}
