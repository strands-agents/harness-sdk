import { Agent, BedrockModel, Graph } from '@strands-agents/sdk'

async function main() {
  const model = new BedrockModel({ maxTokens: 1024 })

  // Define agents as graph nodes
  const researcher = new Agent({
    model,
    printer: false,
    id: 'researcher',
    systemPrompt: 'Research the topic and provide key facts in 2-3 sentences.',
  })

  const writer = new Agent({
    model,
    printer: false,
    id: 'writer',
    systemPrompt: 'Rewrite the research into a polished, concise paragraph.',
  })

  // Linear graph: researcher -> writer
  console.log('=== Linear Graph ===\n')
  const linearGraph = new Graph({
    nodes: [researcher, writer],
    edges: [['researcher', 'writer']],
  })

  const linearResult = await linearGraph.invoke('What is the largest ocean on Earth?')
  console.log('Status:', linearResult.status)
  console.log('Output:', linearResult.content.find((b) => b.type === 'textBlock')?.text)

  // Fan-out graph: router -> [capitals, oceans] (parallel execution)
  console.log('\n=== Fan-Out Graph ===\n')
  const router = new Agent({
    model,
    printer: false,
    id: 'router',
    systemPrompt: 'Repeat the user input exactly.',
  })

  const capitals = new Agent({
    model,
    printer: false,
    id: 'capitals',
    systemPrompt: 'Answer with only the capital of France.',
  })

  const oceans = new Agent({
    model,
    printer: false,
    id: 'oceans',
    systemPrompt: 'Answer with only the largest ocean.',
  })

  const fanOutGraph = new Graph({
    nodes: [router, capitals, oceans],
    edges: [
      ['router', 'capitals'],
      ['router', 'oceans'],
    ],
  })

  const fanOutResult = await fanOutGraph.invoke('Go')
  console.log('Status:', fanOutResult.status)
  console.log('Nodes executed:', fanOutResult.results.map((r) => r.nodeId).join(', '))
  for (const block of fanOutResult.content) {
    if (block.type === 'textBlock') {
      console.log('Output:', block.text)
    }
  }

  // Streaming: access events as nodes execute
  console.log('\n=== Streaming Graph ===\n')
  for await (const event of linearGraph.stream('Explain quantum computing briefly.')) {
    if (event.type === 'multiAgentHandoffEvent') {
      console.log(`Handoff: ${event.source} -> ${event.targets.join(', ')}`)
    } else if (event.type === 'nodeResultEvent') {
      console.log(`Node ${event.result.nodeId}: ${event.result.status}`)
    }
  }
}

await main().catch(console.error)
