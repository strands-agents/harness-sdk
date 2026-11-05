import { Agent } from '@strands-agents/sdk'
import { Choice, Fixed, Inherit, Preset } from '@strands-agents/sdk/multiagent'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'
import { swarm, makeSwarm } from '@strands-agents/sdk/vended-tools/swarm'
import { webFetch } from '@strands-agents/sdk/vended-tools/web-fetch'

// Swarm tool example
async function swarmExample() {
  // --8<-- [start:swarm_example]
  const agent = new Agent({ tools: [swarm] })
  await agent.invoke(
    'Research the pros and cons of microservices vs monoliths and write a summary'
  )
  // --8<-- [end:swarm_example]
}

// Swarm tool with custom configuration
async function swarmCustomExample() {
  // --8<-- [start:swarm_custom_example]
  const swarm = makeSwarm({
    presets: {
      researcher: new Preset({
        instructions: 'You search for and synthesise information.',
        tools: ['http_request', 'web_fetch'],
        description: 'Gathers raw information from the web.',
      }),
      writer: new Preset({
        instructions: 'You write clear, engaging prose.',
        description: 'Turns research into polished text.',
      }),
    },
    defaultPreset: 'researcher',
    instructions: new Choice([
      'You are a researcher.',
      'You are a writer.',
      'You are an editor.',
    ]),
    tools: new Inherit(),
    model: new Fixed('us.amazon.nova-pro-v1:0'),
    maxAgents: 5,
    maxSteps: 15,
    timeout: 300_000,
    nodeTimeout: 120_000,
    repetitiveHandoffDetectionWindow: 6,
    repetitiveHandoffMinUniqueAgents: 3,
  })
  const agent = new Agent({ tools: [swarm, httpRequest, webFetch] })
  await agent.invoke('Write a blog post about AI agents')
  // --8<-- [end:swarm_custom_example]
}
