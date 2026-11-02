import { Agent } from '@strands-agents/sdk'
import { Choice, Preset } from '@strands-agents/sdk/multiagent'
import { graph, makeGraph } from '@strands-agents/sdk/vended-tools/graph'
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor'
import { httpRequest } from '@strands-agents/sdk/vended-tools/http-request'

// Graph tool example
async function graphExample() {
  // --8<-- [start:graph_example]
  const agent = new Agent({ tools: [graph, httpRequest] })
  await agent.invoke(
    'Research three competing vector databases in parallel, then write a comparison table.'
  )
  // --8<-- [end:graph_example]
}

// Graph tool with custom configuration
async function graphCustomExample() {
  // --8<-- [start:graph_custom_example]
  const team = makeGraph({
    presets: {
      researcher: new Preset({
        instructions: 'Gather facts from the web and cite every source.',
        tools: ['http_request'],
        description: 'Finds and summarizes sources.',
      }),
      writer: new Preset({
        instructions: 'Turn upstream findings into clear prose.',
        tools: ['file_editor'],
        description: 'Drafts the final document.',
      }),
    },
    tools: new Choice(['http_request', 'file_editor'], true),
    maxNodes: 6,
    maxEdges: 10,
    timeout: 600_000,
    nodeTimeout: 120_000,
  })
  const agent = new Agent({ tools: [team, httpRequest, fileEditor] })
  // --8<-- [end:graph_custom_example]
}
