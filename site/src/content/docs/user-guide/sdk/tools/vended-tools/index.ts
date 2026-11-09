import { Agent } from '@strands-agents/sdk'
import { bash } from '@strands-agents/sdk/vended-tools/bash'
import { edit } from '@strands-agents/sdk/vended-tools/edit'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { notebook } from '@strands-agents/sdk/vended-tools/notebook'
import { Choice, Fixed, Inherit, Open, Preset } from '@strands-agents/sdk/multiagent'
import type { AgentSpec } from '@strands-agents/sdk/multiagent'
import { makeSubagent } from '@strands-agents/sdk/vended-tools/subagent'

// Agent with vended tools example
async function agentWithVendedToolsExample() {
  // --8<-- [start:agent_with_vended_tools]
  const agent = new Agent({
    tools: [bash, edit, httpRequest, notebook],
  })
  // --8<-- [end:agent_with_vended_tools]
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

// Multi-agent tools example - one policy per axis
async function multiAgentToolsExample() {
  // --8<-- [start:multi_agent_tools_example]
  const delegate = makeSubagent({
    presets: {
      researcher: new Preset({
        instructions: 'You research topics on the web and cite your sources.',
        description: 'web research',
      }),
      summarizer: new Preset({
        instructions: 'You condense documents into short bullet summaries.',
        description: 'summarize a document',
      }),
    },
    defaultPreset: 'researcher',
    instructions: new Open(), // model writes the child's system prompt
    tools: new Fixed(['http_request']), // child can only make HTTP requests
    model: new Inherit(), // child runs on the parent's model
    context: new Choice(['none', 'no_tools']), // model picks how much history to share
  })
  const agent = new Agent({ tools: [bash, httpRequest, delegate] })
  await agent.invoke(
    'Have a subagent summarize the latest Node.js release notes, then run the tests.'
  )
  // --8<-- [end:multi_agent_tools_example]
}

// Custom builder example
async function customBuilderExample() {
  // --8<-- [start:custom_builder_example]
  // Each child gets the resolved instructions and only the HTTP request tool
  const delegate = makeSubagent({
    builder: (spec: AgentSpec) =>
      new Agent({
        name: spec.name,
        systemPrompt: spec.instructions,
        tools: [httpRequest],
      }),
  })
  const agent = new Agent({ tools: [delegate] })
  // --8<-- [end:custom_builder_example]
}
