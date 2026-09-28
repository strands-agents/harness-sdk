import { Agent, Graph, Swarm, ImageBlock, TextBlock } from '@strands-agents/sdk'
import type { ContentBlock } from '@strands-agents/sdk'
import { A2AAgent } from '@strands-agents/sdk/a2a'
import {
  EdgeHandler,
  Node,
  MultiAgentState,
  Status,
} from '@strands-agents/sdk/multiagent'
import type {
  MultiAgentStreamEvent,
  NodeResultUpdate,
} from '@strands-agents/sdk/multiagent'

async function createGraph() {
  // --8<-- [start:create_graph]
  // Create specialized agents
  const researcher = new Agent({
    id: 'research',
    systemPrompt: 'You are a research specialist...',
  })

  const analyst = new Agent({
    id: 'analysis',
    systemPrompt: 'You are a data analysis specialist...',
  })

  const factChecker = new Agent({
    id: 'fact_check',
    systemPrompt: 'You are a fact checking specialist...',
  })

  const reportWriter = new Agent({
    id: 'report',
    systemPrompt: 'You are a report writing specialist...',
  })

  // Build the graph with nodes and edges
  const graph = new Graph({
    nodes: [researcher, analyst, factChecker, reportWriter],
    edges: [
      ['research', 'analysis'],
      ['research', 'fact_check'],
      ['analysis', 'report'],
      ['fact_check', 'report'],
    ],
    // Optional: specify entry points (auto-detected from nodes with no incoming edges)
    sources: ['research'],
    // Optional: configure execution limits for safety
    maxSteps: 20,
  })

  // Execute the graph on a task
  const result = await graph.invoke(
    'Research the impact of AI on healthcare and create a comprehensive report'
  )

  // Access the results
  console.log('Status:', result.status)
  console.log('Execution order:', result.results.map((r) => r.nodeId).join(' -> '))
  // --8<-- [end:create_graph]
}

async function conditionalEdges() {
  const researcher = new Agent({ id: 'research', systemPrompt: '...' })
  const analyst = new Agent({ id: 'analysis', systemPrompt: '...' })

  // --8<-- [start:conditional_edge]
  const onlyIfResearchSuccessful: EdgeHandler = (state) => {
    const resultText = state
      .node('research')!
      .content.map((b) => ('text' in b ? b.text : ''))
      .join('')
    return resultText.toLowerCase().includes('successful')
  }

  // Add conditional edge
  const graph = new Graph({
    nodes: [researcher, analyst],
    edges: [
      { source: 'research', target: 'analysis', handler: onlyIfResearchSuccessful },
    ],
  })
  // --8<-- [end:conditional_edge]
}

async function remoteAgents() {
  // --8<-- [start:remote_agents]
  // Local agents for orchestration
  const dataPrep = new Agent({
    id: 'prep',
    systemPrompt: 'You prepare data for analysis, cleaning and formatting as needed.',
  })

  const reportWriter = new Agent({
    id: 'report',
    systemPrompt: 'You synthesize analysis results into clear, actionable reports.',
  })

  // Remote specialized services
  const mlAnalyzer = new A2AAgent({ url: 'http://ml-service:9000', id: 'ml' })
  const nlpProcessor = new A2AAgent({ url: 'http://nlp-service:9000', id: 'nlp' })

  // Build the distributed graph
  const graph = new Graph({
    nodes: [dataPrep, mlAnalyzer, nlpProcessor, reportWriter],
    edges: [
      ['prep', 'ml'],
      ['prep', 'nlp'],
      ['ml', 'report'],
      ['nlp', 'report'],
    ],
  })

  // Execute the distributed workflow
  const result = await graph.invoke('Analyze customer feedback from Q4 2024')
  console.log('Status:', result.status)
  // --8<-- [end:remote_agents]
}

// --8<-- [start:custom_node]
class ValidatorNode extends Node {
  async *handle(
    args: string | ContentBlock[],
    _state: MultiAgentState
  ): AsyncGenerator<MultiAgentStreamEvent, NodeResultUpdate, undefined> {
    const input = typeof args === 'string' ? args : ''

    if (!input.trim()) {
      throw new Error('Empty input')
    }

    return { content: [new TextBlock(`Validated: ${input.slice(0, 50)}...`)] }
  }
}

// Pass the custom node directly to the graph
const validator = new ValidatorNode('validator', { description: 'Validates input data' })
const processor = new Agent({
  id: 'processor',
  systemPrompt: 'Process the validated data.',
})

const pipelineGraph = new Graph({
  nodes: [validator, processor],
  edges: [['validator', 'processor']],
})
// --8<-- [end:custom_node]

async function nestedPatterns() {
  // --8<-- [start:nested]
  const medicalResearcher = new Agent({
    id: 'medical_researcher',
    systemPrompt: 'You are a medical research specialist...',
  })

  const technologyResearcher = new Agent({
    id: 'technology_researcher',
    systemPrompt: 'You are a technology research specialist...',
  })

  const economicResearcher = new Agent({
    id: 'economic_researcher',
    systemPrompt: 'You are an economic research specialist...',
  })

  // Create a swarm of research agents
  const researchSwarm = new Swarm({
    id: 'research_swarm',
    nodes: [medicalResearcher, technologyResearcher, economicResearcher],
  })

  // Create a single agent node
  const analyst = new Agent({
    id: 'analysis',
    systemPrompt: 'Analyze the provided research.',
  })

  // Create a graph with the swarm as a node
  const graph = new Graph({
    nodes: [researchSwarm, analyst],
    edges: [['research_swarm', 'analysis']],
  })

  const result = await graph.invoke(
    'Research the impact of AI on healthcare and create a comprehensive report'
  )
  console.log(result)
  // --8<-- [end:nested]
}

async function multimodalGraph() {
  // --8<-- [start:multimodal]
  // Create agents for image processing workflow
  const imageAnalyzer = new Agent({
    id: 'image_analyzer',
    systemPrompt: 'You are an image analysis expert...',
  })

  const summarizer = new Agent({
    id: 'summarizer',
    systemPrompt: 'You are a summarization expert...',
  })

  // Build the graph
  const graph = new Graph({
    nodes: [imageAnalyzer, summarizer],
    edges: [['image_analyzer', 'summarizer']],
    sources: ['image_analyzer'],
  })

  // Create content blocks with text and image
  const imageBytes = new Uint8Array(/* your image data */)
  const contentBlocks = [
    new TextBlock('Analyze this image and describe what you see:'),
    new ImageBlock({ format: 'png', source: { bytes: imageBytes } }),
  ]

  // Execute the graph with multi-modal input
  const result = await graph.invoke(contentBlocks)
  // --8<-- [end:multimodal]
}

async function streamingGraph() {
  const researcher = new Agent({
    id: 'research',
    systemPrompt: 'You are a research specialist...',
  })

  const analyst = new Agent({
    id: 'analysis',
    systemPrompt: 'You are an analysis specialist...',
  })

  // --8<-- [start:streaming]
  const graph = new Graph({
    nodes: [researcher, analyst],
    edges: [['research', 'analysis']],
    sources: ['research'],
  })

  for await (const event of graph.stream('Research and analyze market trends')) {
    switch (event.type) {
      // Track node execution
      case 'beforeNodeCallEvent':
        console.log(`\nNode ${event.nodeId} starting`)
        break

      // Monitor node completion
      case 'nodeResultEvent':
        console.log(`\nNode ${event.nodeId} completed in ${event.result.duration}ms`)
        break

      // Track handoffs between nodes
      case 'multiAgentHandoffEvent':
        console.log(`\nHandoff: ${event.source} -> ${event.targets.join(', ')}`)
        break

      // Get final result
      case 'multiAgentResultEvent':
        console.log(`\nGraph completed: ${event.result.status}`)
        break
    }
  }
  // --8<-- [end:streaming]
}

async function graphResults() {
  const researcher = new Agent({
    id: 'research',
    systemPrompt: 'You are a research specialist...',
  })

  const analyst = new Agent({
    id: 'analysis',
    systemPrompt: 'You are an analysis specialist...',
  })

  // --8<-- [start:results]
  const graph = new Graph({
    nodes: [researcher, analyst],
    edges: [['research', 'analysis']],
  })

  const result = await graph.invoke('Research and analyze...')

  // Check execution status
  console.log('Status:', result.status)

  // See which nodes were executed
  for (const nodeResult of result.results) {
    console.log(`Node: ${nodeResult.nodeId}, Status: ${nodeResult.status}`)
  }

  // Get performance metrics
  console.log('Duration:', result.duration, 'ms')

  // Get the final output
  console.log('Output:', result.content.find((b) => b.type === 'textBlock')?.text)
  // --8<-- [end:results]
}

async function topologySequential() {
  const researcher = new Agent({ id: 'research', systemPrompt: '...' })
  const analyst = new Agent({ id: 'analysis', systemPrompt: '...' })
  const reviewer = new Agent({ id: 'review', systemPrompt: '...' })
  const reportWriter = new Agent({ id: 'report', systemPrompt: '...' })

  // --8<-- [start:topology_sequential]
  const graph = new Graph({
    nodes: [researcher, analyst, reviewer, reportWriter],
    edges: [
      ['research', 'analysis'],
      ['analysis', 'review'],
      ['review', 'report'],
    ],
  })
  // --8<-- [end:topology_sequential]
}

async function topologyParallel() {
  const coordinator = new Agent({ id: 'coordinator', systemPrompt: '...' })
  const worker1 = new Agent({ id: 'worker1', systemPrompt: '...' })
  const worker2 = new Agent({ id: 'worker2', systemPrompt: '...' })
  const worker3 = new Agent({ id: 'worker3', systemPrompt: '...' })
  const aggregator = new Agent({ id: 'aggregator', systemPrompt: '...' })

  // --8<-- [start:topology_parallel]
  const graph = new Graph({
    nodes: [coordinator, worker1, worker2, worker3, aggregator],
    edges: [
      ['coordinator', 'worker1'],
      ['coordinator', 'worker2'],
      ['coordinator', 'worker3'],
      ['worker1', 'aggregator'],
      ['worker2', 'aggregator'],
      ['worker3', 'aggregator'],
    ],
  })
  // --8<-- [end:topology_parallel]
}

async function topologyBranching() {
  const classifier = new Agent({ id: 'classifier', systemPrompt: '...' })
  const techSpecialist = new Agent({ id: 'tech_specialist', systemPrompt: '...' })
  const businessSpecialist = new Agent({ id: 'business_specialist', systemPrompt: '...' })
  const techReport = new Agent({ id: 'tech_report', systemPrompt: '...' })
  const businessReport = new Agent({ id: 'business_report', systemPrompt: '...' })

  // --8<-- [start:topology_branching]
  const isTechnical: EdgeHandler = (state) => {
    const resultText = state
      .node('classifier')!
      .content.map((b) => ('text' in b ? b.text : ''))
      .join('')
    return resultText.toLowerCase().includes('technical')
  }

  const isBusiness: EdgeHandler = (state) => {
    const resultText = state
      .node('classifier')!
      .content.map((b) => ('text' in b ? b.text : ''))
      .join('')
    return resultText.toLowerCase().includes('business')
  }

  const graph = new Graph({
    nodes: [classifier, techSpecialist, businessSpecialist, techReport, businessReport],
    edges: [
      { source: 'classifier', target: 'tech_specialist', handler: isTechnical },
      { source: 'classifier', target: 'business_specialist', handler: isBusiness },
      ['tech_specialist', 'tech_report'],
      ['business_specialist', 'business_report'],
    ],
  })
  // --8<-- [end:topology_branching]
}

async function topologyFeedbackLoop() {
  const draftWriter = new Agent({ id: 'draft_writer', systemPrompt: '...' })
  const reviewer = new Agent({ id: 'reviewer', systemPrompt: '...' })
  const publisher = new Agent({ id: 'publisher', systemPrompt: '...' })

  // --8<-- [start:topology_feedback]
  const needsRevision: EdgeHandler = (state) => {
    const resultText = state
      .node('reviewer')!
      .content.map((b) => ('text' in b ? b.text : ''))
      .join('')
    return resultText.toLowerCase().includes('revision needed')
  }

  const isApproved: EdgeHandler = (state) => {
    const resultText = state
      .node('reviewer')!
      .content.map((b) => ('text' in b ? b.text : ''))
      .join('')
    return resultText.toLowerCase().includes('approved')
  }

  const graph = new Graph({
    nodes: [draftWriter, reviewer, publisher],
    edges: [
      ['draft_writer', 'reviewer'],
      { source: 'reviewer', target: 'draft_writer', handler: needsRevision },
      { source: 'reviewer', target: 'publisher', handler: isApproved },
    ],
    // Set execution limits to prevent infinite loops
    maxSteps: 10,
  })
  // --8<-- [end:topology_feedback]
}
