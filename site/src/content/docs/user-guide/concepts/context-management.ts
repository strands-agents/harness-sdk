import { Agent } from '@strands-agents/sdk'

async function basic() {
  // --8<-- [start:basic]
  const agent = new Agent({
    contextManager: 'auto',
  })
  // --8<-- [end:basic]
}

async function agentic() {
  // --8<-- [start:agentic]
  const agent = new Agent({
    contextManager: 'agentic',
  })
  // --8<-- [end:agentic]
}
