import { Agent, tool } from '@strands-agents/sdk'
import { HumanInTheLoop } from '@strands-agents/sdk/vended-interventions/hitl'
import { z } from 'zod'

async function classifierExample() {
  // --8<-- [start:classifier]
  const listFiles = tool({
    name: 'list_files',
    description: 'List the files in a directory.',
    inputSchema: z.object({ directory: z.string() }),
    callback: () => ['app.log', 'app.log.1', 'app.log.2'],
  })

  const deleteFiles = tool({
    name: 'delete_files',
    description: 'Delete the files at the given paths.',
    inputSchema: z.object({ paths: z.array(z.string()) }),
    callback: ({ paths }) => `Deleted ${paths.length} files`,
  })

  const agent = new Agent({
    tools: [listFiles, deleteFiles],
    interventions: [
      new HumanInTheLoop({ classifier: true, ask: 'stdio', enableTrust: true }),
    ],
  })

  await agent.invoke('Delete the rotated logs in /var/log/app')
  // --8<-- [end:classifier]
}

void classifierExample
