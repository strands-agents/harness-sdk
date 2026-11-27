import { Agent } from '@strands-agents/sdk'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'

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
