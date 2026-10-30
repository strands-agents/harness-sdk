import { Agent, SessionManager, FileStorage } from '@strands-agents/sdk'
import { notebook, makeNotebook } from '@strands-agents/sdk/vended-tools/notebook'

// Notebook example - task management
async function notebookTaskExample() {
  // --8<-- [start:notebook_example]
  const agent = new Agent({
    tools: [notebook],
    systemPrompt:
      'Before starting any multi-step task, create a notebook with a checklist of steps. ' +
      'Check off each step as you complete it.',
  })

  // The agent uses the notebook to plan and track its work
  await agent.invoke('Write a project plan for building a personal budget tracker app')
  // --8<-- [end:notebook_example]
}

// Notebook custom configuration example
async function notebookMakeExample() {
  // --8<-- [start:notebook_custom_example]
  const notes = makeNotebook({
    name: 'notes',
    maxNotebookSizeBytes: 64 * 1024, // 64 KiB
  })
  const agent = new Agent({ tools: [notes] })
  // --8<-- [end:notebook_custom_example]
}

// Notebook state persistence example
async function notebookStatePersistenceExample() {
  // --8<-- [start:notebook_state_persistence]
  const session = new SessionManager({
    sessionId: 'my-session',
    storage: { snapshot: new FileStorage('./sessions') },
  })

  const agent = new Agent({ tools: [notebook], sessionManager: session })

  // Notebooks are automatically persisted as part of the session
  await agent.invoke('Create a notebook called "ideas" with "# Project Ideas"')
  await agent.invoke('Add "- Build a web scraper" to the ideas notebook')

  // ...

  // Later, a new agent with the same session restores notebooks automatically
  const restoredAgent = new Agent({ tools: [notebook], sessionManager: session })
  await restoredAgent.invoke('Read the ideas notebook')
  // --8<-- [end:notebook_state_persistence]
}
