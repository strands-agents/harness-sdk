import { describe, expect, it } from 'vitest'
import { Agent, tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { bedrock } from './__fixtures__/model-providers.js'

const getTigerHeight = tool({
  name: 'get_tiger_height',
  description: 'Returns the height of a tiger in centimeters',
  inputSchema: z.object({}),
  callback: async () => 100,
})

describe.skipIf(bedrock.skip)('AgentAsTool (integration)', () => {
  it('parent agent invokes a sub-agent tool that uses a standard tool and gets a result', async () => {
    const innerAgent = new Agent({
      model: bedrock.createModel({ maxTokens: 500 }),
      name: 'tiger_expert',
      description: 'An agent knowledgeable about tigers',
      tools: [getTigerHeight],
      printer: false,
    })

    const outerAgent = new Agent({
      model: bedrock.createModel({ maxTokens: 500 }),
      tools: [innerAgent.asTool()],
      printer: false,
    })

    const result = await outerAgent.invoke('Ask the tiger_expert about the height of tigers.')

    expect(result.stopReason).toBe('endTurn')
    expect(result.metrics?.toolMetrics['tiger_expert']?.successCount).toBeGreaterThanOrEqual(1)
  })
})
