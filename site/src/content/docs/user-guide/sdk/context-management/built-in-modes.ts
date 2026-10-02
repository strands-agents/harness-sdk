import { Agent } from '@strands-agents/sdk'

async function auto() {
  // --8<-- [start:auto]
  const agent = new Agent({
    contextManager: 'auto',
  })
  // --8<-- [end:auto]
}

async function agentic() {
  // --8<-- [start:agentic]
  const agent = new Agent({
    contextManager: 'agentic',
  })
  // --8<-- [end:agentic]
}

async function disabled() {
  // --8<-- [start:disabled]
  const agent = new Agent({
    contextManager: false,
  })
  // --8<-- [end:disabled]
}
