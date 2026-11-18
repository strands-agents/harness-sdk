import { Agent } from '@strands-agents/sdk'

async function sequentialWorkflowExample() {
  // --8<-- [start:workflow_sequential]
  async function processWorkflow(notes: string): Promise<string> {
    const researcher = new Agent({
      systemPrompt: 'Extract the facts in the supplied incident notes.',
      printer: false,
    })
    const analyst = new Agent({
      systemPrompt: 'Analyze the supplied facts. Distinguish causes from guesses.',
      printer: false,
    })
    const writer = new Agent({
      systemPrompt: 'Write a concise incident report from the supplied analysis.',
      printer: false,
    })

    const facts = await researcher.invoke(`Extract facts from these notes:\n${notes}`)
    const analysis = await analyst.invoke(`Analyze these incident facts:\n${facts}`)
    const report = await writer.invoke(`Write a report from this analysis:\n${analysis}`)
    return report.toString()
  }

  // Fictional notes keep the example independent of external data sources.
  const notes =
    '09:00: deployed version 2.3. 09:05: checkout errors increased. ' +
    '09:12: rolled back to version 2.2. 09:15: error rate returned to normal. ' +
    'Root cause has not been confirmed.'
  console.log(await processWorkflow(notes))
  // --8<-- [end:workflow_sequential]
}

void sequentialWorkflowExample
