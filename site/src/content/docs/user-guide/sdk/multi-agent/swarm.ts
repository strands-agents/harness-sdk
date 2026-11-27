import { Agent, Swarm, ImageBlock, TextBlock } from '@strands-agents/sdk'

async function multimodalSwarm() {
  // --8<-- [start:multimodal]
  // Create agents for image processing workflow
  const imageAnalyzer = new Agent({
    id: 'image_analyzer',
    description: 'Analyzes images and extracts key details.',
    systemPrompt: 'You are an image analysis expert...',
  })

  const reportWriter = new Agent({
    id: 'report_writer',
    description: 'Writes reports based on analysis.',
    systemPrompt: 'You are a report writing expert...',
  })

  // Create the swarm
  const swarm = new Swarm({
    nodes: [imageAnalyzer, reportWriter],
  })

  // Create content blocks with text and image
  const imageBytes = new Uint8Array(/* your image data */)
  const contentBlocks = [
    new TextBlock('Analyze this image and create a report about what you see:'),
    new ImageBlock({ format: 'png', source: { bytes: imageBytes } }),
  ]

  // Execute the swarm with multi-modal input
  const result = await swarm.invoke(contentBlocks)
  // --8<-- [end:multimodal]
}

async function swarmTeam() {
  // --8<-- [start:swarm_team]
  const researcher = new Agent({
    id: 'researcher',
    description: 'Researches topics and gathers information.',
    systemPrompt: 'You are a research specialist...',
  })

  const architect = new Agent({
    id: 'architect',
    description: 'Designs system architecture based on research.',
    systemPrompt: 'You are a system architecture specialist...',
  })

  const coder = new Agent({
    id: 'coder',
    description: 'Implements code based on architecture designs.',
    systemPrompt: 'You are a coding specialist...',
  })

  const reviewer = new Agent({
    id: 'reviewer',
    description: 'Reviews code and provides the final result.',
    systemPrompt: 'You are a code review specialist...',
  })

  const swarm = new Swarm({
    nodes: [researcher, architect, coder, reviewer],
    start: 'researcher',
    maxSteps: 10,
  })

  // Execute the swarm on a task
  const result = await swarm.invoke(
    'Design and implement a simple REST API for a todo app'
  )

  // Access the final result
  console.log('Status:', result.status)
  console.log('Node history:', result.results.map((r) => r.nodeId).join(' -> '))
  // --8<-- [end:swarm_team]
}

async function streamingSwarm() {
  const coordinator = new Agent({
    id: 'coordinator',
    description: 'Coordinates tasks.',
    systemPrompt: 'You coordinate tasks...',
  })

  const specialist = new Agent({
    id: 'specialist',
    description: 'Handles specialized work.',
    systemPrompt: 'You handle specialized work...',
  })

  // --8<-- [start:streaming]
  const swarm = new Swarm({
    nodes: [coordinator, specialist],
    maxSteps: 4,
  })

  for await (const event of swarm.stream('Design and implement a REST API')) {
    switch (event.type) {
      // Track handoffs between agents
      case 'multiAgentHandoffEvent':
        console.log(`\nHandoff: ${event.source} -> ${event.targets.join(', ')}`)
        break

      // Monitor individual node results
      case 'nodeResultEvent':
        console.log(`\nNode ${event.result.nodeId}: ${event.result.status}`)
        break

      // Get final result
      case 'multiAgentResultEvent':
        console.log(`\nSwarm completed: ${event.result.status}`)
        break
    }
  }
  // --8<-- [end:streaming]
}

async function swarmResults() {
  const researcher = new Agent({
    id: 'researcher',
    description: 'Researches a topic.',
    systemPrompt: 'You are a research specialist...',
  })

  const writer = new Agent({
    id: 'writer',
    description: 'Writes a polished answer.',
    systemPrompt: 'You are a writing specialist...',
  })

  // --8<-- [start:results]
  const swarm = new Swarm({
    nodes: [researcher, writer],
    maxSteps: 4,
  })

  const result = await swarm.invoke('Design a system architecture for...')

  // Check execution status
  console.log('Status:', result.status)

  // See which agents were involved
  for (const nodeResult of result.results) {
    console.log(`Agent: ${nodeResult.nodeId}`)
  }

  // Get performance metrics
  console.log('Duration:', result.duration, 'ms')

  // Get the final output
  console.log('Output:', result.content.find((b) => b.type === 'textBlock')?.text)
  // --8<-- [end:results]
}
