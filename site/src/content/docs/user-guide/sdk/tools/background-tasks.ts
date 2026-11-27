import { Agent, JsonBlock, tool } from '@strands-agents/sdk'
import { setTimeout as sleep } from 'node:timers/promises'
import { z } from 'zod'

async function basicExample() {
  // --8<-- [start:background_basic]
  const buildReport = tool({
    name: 'build_report',
    description: 'Build an example sales report for a region.',
    inputSchema: z.object({ region: z.string() }),
    callback: async ({ region }) => {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      return `Example report for ${region}: revenue grew 12%.`
    },
  })

  const agent = new Agent({
    tools: [buildReport],
    backgroundTasks: {
      always: [buildReport],
      never: ['*'],
      maxConcurrency: 2,
      timeout: 30_000,
    },
  })
  const result = await agent.invoke(
    'Build the north region report. While it runs, outline three ' +
      'questions to ask about sales growth. Then summarize the report.'
  )
  console.log(result.toString())
  // --8<-- [end:background_basic]
}

async function manageExample() {
  // --8<-- [start:background_manage]
  const buildReport = tool({
    name: 'build_report',
    description: 'Build an example report after a simulated slow query.',
    inputSchema: z.object({ region: z.string() }),
    callback: async ({ region }, context) => {
      await sleep(10_000, undefined, { signal: context?.cancelSignal })
      return `Example report for ${region}: revenue grew 12%.`
    },
  })

  const agent = new Agent({
    tools: [buildReport],
    systemPrompt: 'Report cancelled tasks without retrying them.',
    backgroundTasks: {
      always: [buildReport],
      never: ['*'],
      waitForCompletion: false,
    },
  })
  await agent.invoke('Start the north region report and tell me it has started.')

  const manage = agent.tool.strands_manage_background_task!
  const listing = await manage.invoke({ mode: 'list' }, { recordDirectToolCall: false })
  const block = listing.content[0]
  if (!(block instanceof JsonBlock)) throw new Error('Expected a task list')
  const { tasks } = z
    .object({
      tasks: z.array(z.object({ taskId: z.string(), status: z.string() })),
    })
    .parse(block.json)

  for (const task of tasks) {
    console.log(
      await manage.invoke(
        { mode: 'get', taskId: task.taskId },
        { recordDirectToolCall: false }
      )
    )
    if (['queued', 'working', 'input_required'].includes(task.status)) {
      await manage.invoke(
        { mode: 'cancel', taskId: task.taskId },
        { recordDirectToolCall: false }
      )
    }
  }

  // Deliver any recorded outcomes to the agent.
  console.log((await agent.invoke([])).toString())
  // --8<-- [end:background_manage]
}
