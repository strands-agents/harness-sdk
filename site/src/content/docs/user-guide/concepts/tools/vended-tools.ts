// --8<-- [start:basic_import]
import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'
// --8<-- [end:basic_import]
import { SessionManager, FileStorage } from '@strands-agents/sdk'
import { sleep, makeSleep } from '@strands-agents/sdk/vended-tools/sleep'
import { stop } from '@strands-agents/sdk/experimental/vended-tools/stop'
import { webFetch, makeWebFetch } from '@strands-agents/sdk/vended-tools/web-fetch'
import { BedrockModel } from '@strands-agents/sdk/models/bedrock'

// Agent with vended tools example
async function agentWithVendedToolsExample() {
  // --8<-- [start:agent_with_vended_tools]
  const agent = new Agent({
    tools: [bash, fileEditor, httpRequest, notebook],
  })
  // --8<-- [end:agent_with_vended_tools]
}

// Bash tool example - file operations
async function bashFileOperationsExample() {
  // --8<-- [start:bash_example]
  const agent = new Agent({
    tools: [bash],
  })

  // List files and create a new file
  await agent.invoke('List all files in the current directory')
  await agent.invoke('Create a new file called notes.txt with "Hello World"')
  // --8<-- [end:bash_example]
}

// Bash tool example - session persistence
async function bashSessionPersistenceExample() {
  // --8<-- [start:bash_session]
  const agent = new Agent({
    tools: [bash],
  })

  // Variables persist across invocations within the same session
  await agent.invoke('Run: export MY_VAR="hello"')
  await agent.invoke('Run: echo $MY_VAR') // Will show "hello"

  // Restart session to clear state
  await agent.invoke('Restart the bash session')
  await agent.invoke('Run: echo $MY_VAR') // Variable will be empty
  // --8<-- [end:bash_session]
}

// File editor example
async function fileEditorExample() {
  // --8<-- [start:file_editor_example]
  const agent = new Agent({
    tools: [fileEditor],
  })

  // Create, view, and edit files
  await agent.invoke('Create a file /tmp/config.json with {"debug": false}')
  await agent.invoke('Replace "debug": false with "debug": true in /tmp/config.json')
  await agent.invoke('View lines 1-10 of /tmp/config.json')
  // --8<-- [end:file_editor_example]
}

// HTTP request example
async function httpRequestExample() {
  // --8<-- [start:http_request_example]
  const agent = new Agent({
    tools: [httpRequest],
  })

  // Make API requests
  await agent.invoke('Get data from https://api.example.com/users')
  await agent.invoke('Post {"name": "John"} to https://api.example.com/users')
  // --8<-- [end:http_request_example]
}

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

// Combined tools example - development workflow
async function combinedToolsExample() {
  // --8<-- [start:combined_tools_example]
  const agent = new Agent({
    tools: [bash, fileEditor, notebook],
    systemPrompt: [
      'You are a software development assistant.',
      'When given a feature to implement:',
      '1. Use the notebook tool to create a plan with a checklist of steps',
      '2. Work through each step, checking them off as you go',
      '3. Use the bash tool to run tests and verify your changes',
    ].join('\n'),
  })

  // Agent plans the work, implements it, and tracks progress
  await agent.invoke(
    'Add input validation to the createUser function in src/users.ts. ' +
      'It should reject empty names and invalid email formats.'
  )
  // --8<-- [end:combined_tools_example]
}

// Sleep tool example
async function sleepExample() {
  // --8<-- [start:sleep_example]
  const agent = new Agent({
    tools: [sleep],
  })
  await agent.invoke('Pause for two seconds, then continue.')
  // --8<-- [end:sleep_example]
}

// Sleep tool custom maximum
async function sleepCustomExample() {
  // --8<-- [start:sleep_custom_example]
  const shortSleep = makeSleep({ maxDuration: 5 })
  const agent = new Agent({ tools: [shortSleep] })
  // --8<-- [end:sleep_custom_example]
}

// Stop tool example
async function stopExample() {
  // --8<-- [start:stop_example]
  const agent = new Agent({
    tools: [stop],
    systemPrompt: 'Complete the task. Call stop with a short summary when you are done.',
  })
  await agent.invoke('Summarize the changes in ./CHANGELOG.md')
  // --8<-- [end:stop_example]
}

// Web fetch example
async function webFetchExample() {
  // --8<-- [start:web_fetch_example]
  const agent = new Agent({ tools: [webFetch] })
  await agent.invoke('Summarize https://example.com/blog/post')
  // --8<-- [end:web_fetch_example]
}

// Web fetch markdown mode example
async function webFetchMarkdownExample() {
  // --8<-- [start:web_fetch_markdown_example]
  const webFetch = makeWebFetch({ mode: 'markdown' })
  const agent = new Agent({ tools: [webFetch] })
  await agent.invoke('Read https://example.com/docs and explain the architecture')
  // --8<-- [end:web_fetch_markdown_example]
}

// Web fetch custom config example
async function webFetchCustomExample() {
  // --8<-- [start:web_fetch_custom_example]
  const webFetch = makeWebFetch({
    mode: 'agentic',
    maxBytes: 1 * 1024 * 1024,
    maxContentChars: 25_000,
    model: new BedrockModel({ modelId: 'us.amazon.nova-micro-v1:0' }),
  })
  const agent = new Agent({ tools: [webFetch] })
  // --8<-- [end:web_fetch_custom_example]
  void agent
}
