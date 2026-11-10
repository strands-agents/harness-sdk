import { Agent, BedrockModel, Swarm } from '@strands-agents/sdk'

async function main() {
  const model = new BedrockModel({ maxTokens: 1024 })

  // Define swarm agents with descriptions (used for routing decisions)
  const researcher = new Agent({
    model,
    printer: false,
    id: 'researcher',
    description: 'Researches a topic and gathers key facts.',
    systemPrompt:
      'You are a researcher. Look up the answer, then hand off to the writer agent. Never produce a final response yourself.',
  })

  const writer = new Agent({
    model,
    printer: false,
    id: 'writer',
    description: 'Writes a polished final answer.',
    systemPrompt: 'Write the final answer in one clear paragraph. Do not hand off to another agent.',
  })

  // Swarm: researcher hands off to writer via structured output
  console.log('=== Swarm Orchestration ===\n')
  const swarm = new Swarm({
    nodes: [researcher, writer],
    start: 'researcher',
    maxSteps: 4,
  })

  const result = await swarm.invoke('What is the largest ocean on Earth?')
  console.log('Status:', result.status)
  console.log('Agents executed:', result.results.map((r) => r.nodeId).join(' -> '))
  console.log('Output:', result.content.find((b) => b.type === 'textBlock')?.text)

  // Streaming: access handoff events in real-time
  console.log('\n=== Streaming Swarm ===\n')
  for await (const event of swarm.stream('Explain quantum computing briefly.')) {
    if (event.type === 'multiAgentHandoffEvent') {
      console.log(`Handoff: ${event.source} -> ${event.targets.join(', ')}`)
    } else if (event.type === 'nodeResultEvent') {
      console.log(`Node ${event.result.nodeId}: ${event.result.status}`)
    }
  }
}

await main().catch(console.error)
