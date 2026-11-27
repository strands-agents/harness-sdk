import { Agent, tool } from '@strands-agents/sdk'
import { DogwoodAuthorization } from '@strands-agents/sdk/vended-interventions/dogwood'
import { z } from 'zod'

const searchTool = tool({
  name: 'search',
  description: 'Search for information',
  inputSchema: z.object({ query: z.string() }),
  callback: (input) => `Results for: ${input.query}`,
})

const deleteTool = tool({
  name: 'delete_record',
  description: 'Delete a record by ID',
  inputSchema: z.object({ record_id: z.string() }),
  callback: (input) => `Deleted ${input.record_id}`,
})

async function basicExample() {
  // --8<-- [start:basic]
  const dogwood = new DogwoodAuthorization({
    policies: 'permit(principal, action == Action::"search", resource);',
    tools: [searchTool, deleteTool],
  })

  const agent = new Agent({
    tools: [searchTool, deleteTool],
    interventions: [dogwood],
  })

  await agent.invoke('Search for quarterly reports, then delete record 42')
  // search runs; delete_record is denied because no permit matches it
  // --8<-- [end:basic]
}

async function temporalExample() {
  // --8<-- [start:temporal]
  const dogwood = new DogwoodAuthorization({
    policies: `
      permit(principal, action == Action::"search", resource);

      permit(principal, action == Action::"delete_record", resource)
      when temporal {
        formerly within 1h Action::"search"::response{}
      };
    `,
    tools: [searchTool, deleteTool],
  })

  const agent = new Agent({
    tools: [searchTool, deleteTool],
    interventions: [dogwood],
    // The default concurrent executor decides every call in a turn before recording
    // any result, so the rule above would not see the search when the model emits
    // both calls at once.
    toolExecutor: 'sequential',
  })

  // Denied: nothing has been searched yet in this session
  await agent.invoke('Delete record 42')

  // Permitted: the search completed less than an hour ago
  await agent.invoke('Find record 42, then delete it')
  // --8<-- [end:temporal]
}

async function identityExample() {
  // --8<-- [start:identity]
  const dogwood = new DogwoodAuthorization({
    policies: `
      permit(principal == User::"alice", action, resource);

      permit(principal == User::"bob", action == Action::"search", resource);
    `,
    tools: [searchTool, deleteTool],
    principalResolver: (state) =>
      state.userId ? { type: 'User', id: String(state.userId) } : undefined,
  })

  const agent = new Agent({
    tools: [searchTool, deleteTool],
    interventions: [dogwood],
  })

  await agent.invoke('Delete record 42', {
    invocationState: { userId: 'alice' },
  })

  // Denied: bob may only search
  await agent.invoke('Delete record 42', {
    invocationState: { userId: 'bob' },
  })
  // --8<-- [end:identity]
}

function filePolicyExample() {
  // --8<-- [start:file_policy]
  const dogwood = new DogwoodAuthorization({
    policies: './policies/agent.dw',
    actionSchema: './policies/agent.cedarschema',
  })
  // --8<-- [end:file_policy]
  void dogwood
}

async function sessionScopeExample() {
  // --8<-- [start:session_scope]
  // One agent per session, because reset() clears every principal's history
  const dogwood = new DogwoodAuthorization({
    policies: 'permit(principal, action == Action::"search", resource);',
    tools: [searchTool],
    principal: { type: 'User', id: 'alice' },
  })

  const agent = new Agent({ tools: [searchTool], interventions: [dogwood] })

  await agent.invoke('Search for quarterly reports')

  // The session is over: forget what the agent did, keep the policy set
  dogwood.reset()
  // --8<-- [end:session_scope]
}

void basicExample
void temporalExample
void identityExample
void filePolicyExample
void sessionScopeExample
