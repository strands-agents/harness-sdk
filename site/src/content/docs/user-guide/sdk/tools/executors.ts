import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'

const weatherTool = tool({
  name: 'weather',
  description: 'Get the weather for a location',
  inputSchema: z.object({
    location: z.string().describe('The location'),
  }),
  callback: (input) => `Sunny in ${input.location}`,
})

const timeTool = tool({
  name: 'time',
  description: 'Get the current time for a location',
  inputSchema: z.object({
    location: z.string().describe('The location'),
  }),
  callback: (input) => `12:00 PM in ${input.location}`,
})

const screenshotTool = tool({
  name: 'screenshot',
  description: 'Take a screenshot',
  inputSchema: z.object({}),
  callback: () => 'Screenshot taken',
})

const emailTool = tool({
  name: 'email',
  description: 'Send an email',
  inputSchema: z.object({
    to: z.string().describe('Recipient'),
  }),
  callback: (input) => `Email sent to ${input.to}`,
})

{
  // --8<-- [start:concurrent]
  const agent = new Agent({
    tools: [weatherTool, timeTool],
    toolExecutor: 'concurrent',
  })
  // Concurrent execution is the default; omit toolExecutor for the same result.

  await agent.invoke('What is the weather and time in New York?')
  // --8<-- [end:concurrent]
}

{
  // --8<-- [start:sequential]
  const agent = new Agent({
    tools: [screenshotTool, emailTool],
    toolExecutor: 'sequential',
  })

  await agent.invoke('Take a screenshot and email it to my friend')
  // --8<-- [end:sequential]
}
