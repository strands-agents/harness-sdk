import { Agent } from '@strands-agents/sdk'

// --8<-- [start:workflow_sequential]
const researcher = new Agent({
  systemPrompt: 'You are a research specialist. Find key information.',
  printer: false,
})
const analyst = new Agent({
  systemPrompt: 'You analyze research data and extract insights.',
  printer: false,
})
const writer = new Agent({
  systemPrompt: 'You create polished reports based on analysis.',
})

async function processWorkflow(topic: string) {
  const researchResults = await researcher.invoke(
    `Research the latest developments in ${topic}`
  )
  const analysis = await analyst.invoke(
    `Analyze these research findings: ${researchResults.toString()}`
  )
  const finalReport = await writer.invoke(
    `Create a report based on this analysis: ${analysis.toString()}`
  )

  return finalReport
}

await processWorkflow('renewable energy')
// --8<-- [end:workflow_sequential]
