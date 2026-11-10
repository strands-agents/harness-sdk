import { Agent, tool } from '@strands-agents/sdk'
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar'
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

async function cedarExample() {
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

  // --8<-- [start:cedar]
  const cedar = new CedarAuthorization({
    policies: `
      permit(principal, action == Action::"list_files", resource);

      permit(
        principal == User::"alice",
        action == Action::"delete_files",
        resource
      );
    `,
    principalResolver: (state) => ({ type: 'User', id: String(state.user_id) }),
  })

  const agent = new Agent({
    tools: [listFiles, deleteFiles],
    interventions: [
      cedar,
      new HumanInTheLoop({ classifier: true, ask: 'stdio', enableTrust: true }),
    ],
  })

  // alice is asked to approve the delete
  await agent.invoke('Delete the rotated logs in /var/log/app', {
    invocationState: { user_id: 'alice' },
  })

  // bob's delete is denied without a prompt
  await agent.invoke('Delete the rotated logs in /var/log/app', {
    invocationState: { user_id: 'bob' },
  })
  // --8<-- [end:cedar]
}

void classifierExample
void cedarExample
