import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'

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
