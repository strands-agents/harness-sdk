import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent, tool } from '$/sdk/index.js'
import { programmaticToolCaller } from '$/sdk/vended-tools/programmatic-tool-caller/index.js'
import { bedrock } from '../__fixtures__/model-providers.js'

describe.skipIf(bedrock.skip)('Programmatic Tool Caller Integration', () => {
  it('runs model-written code that calls a tool in a loop and returns what it printed', async () => {
    const stock: Record<string, number> = { apples: 12, pears: 7, plums: 23 }
    const lookedUp: string[] = []
    const getStock = tool({
      name: 'get_stock',
      description: 'Get the number of units in stock for one item, as an integer.',
      inputSchema: z.object({ item: z.string() }),
      callback: ({ item }) => {
        lookedUp.push(item)
        return stock[item] ?? 0
      },
    })
    const agent = new Agent({
      model: bedrock.createModel({ region: 'us-east-1' }),
      tools: [programmaticToolCaller, getStock],
      printer: false,
    })

    await agent.invoke(
      'With a single programmatic_tool_caller call, loop over apples, pears and plums, ' +
        'look up the stock of each with get_stock, and print the total.'
    )

    const blocks = agent.messages.flatMap((message) => message.content)
    const codeRuns = blocks.flatMap((block) =>
      block.type === 'toolUseBlock' && block.name === 'programmatic_tool_caller' ? [block.toolUseId] : []
    )
    const printed = blocks.flatMap((block) =>
      block.type === 'toolResultBlock' && block.status === 'success' && codeRuns.includes(block.toolUseId)
        ? block.content.map((content) => (content.type === 'textBlock' ? content.text : ''))
        : []
    )
    // Calls made from the code never appear in the transcript, so this pins the lookups to the code.
    expect(blocks.filter((block) => block.type === 'toolUseBlock' && block.name === 'get_stock')).toStrictEqual([])
    expect([...new Set(lookedUp)].sort()).toStrictEqual(['apples', 'pears', 'plums'])
    expect(printed.join('\n')).toContain('42')
  })
})
