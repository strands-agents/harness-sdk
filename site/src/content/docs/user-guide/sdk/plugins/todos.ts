import { Agent } from '@strands-agents/sdk'
import { Todos } from '@strands-agents/sdk/vended-plugins/todos'
import type { TodoItem } from '@strands-agents/sdk/vended-plugins/todos'

// =====================
// Getting Started
// =====================

async function gettingStarted() {
  // --8<-- [start:getting_started]
  const agent = new Agent({ plugins: [new Todos()] })
  await agent.invoke('Refactor the auth module, then update its tests and the changelog.')
  // --8<-- [end:getting_started]
}
void gettingStarted

// =====================
// Read the list yourself
// =====================

function inspectState(agent: Agent) {
  // --8<-- [start:inspect_state]
  const todos = (agent.appState.get('todos') as TodoItem[] | undefined) ?? []
  for (const todo of todos) {
    console.log(todo.status, todo.content)
  }
  // --8<-- [end:inspect_state]
}
void inspectState
