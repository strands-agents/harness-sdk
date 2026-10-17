import { describe, expect, it } from 'vitest'
import { Agent, MaxTokensError, TextBlock, tool } from '@strands-agents/sdk'
import { z } from 'zod'

import { bedrock } from './__fixtures__/model-providers.js'

const storyTool = tool({
  name: 'story_tool',
  description: 'Tool that writes a story that is minimum 50,000 lines long.',
  inputSchema: z.object({ story: z.string() }),
  callback: ({ story }) => story,
})

describe.skipIf(bedrock.skip)('max tokens reached', () => {
  it('adds the recovered partial message to history so the agent can be invoked again', async () => {
    const model = bedrock.createModel({ maxTokens: 100 })
    const agent = new Agent({ model, tools: [storyTool], printer: false })

    await expect(agent.invoke('Tell me a story!')).rejects.toThrow(MaxTokensError)

    const lastMessage = agent.messages.at(-1)!
    expect(lastMessage.role).toBe('assistant')
    expect(lastMessage.content.some((block) => block.type === 'toolUseBlock')).toBe(false)
    const texts = lastMessage.content.filter((block): block is TextBlock => block instanceof TextBlock)
    expect(
      texts.some((block) => block.text.includes('tool use was incomplete due to maximum token limits being reached'))
    ).toBe(true)

    model.updateConfig({ maxTokens: 1024 })
    const result = await agent.invoke('What is 3+3')

    expect(result.stopReason).toBe('endTurn')
  })
})
