import { Agent, Graph, SessionManager, tool } from '@strands-agents/sdk'
import { z } from 'zod'
import { LocalFileStorage } from '@strands-agents/sdk/storage'
import { setupTracer } from '@strands-agents/sdk/telemetry'

// =====================
// Worked example: the casework graph, migrated
// =====================

async function migratedGraph() {
  // --8<-- [start:graph_migrated]
  const fetchCaseRecord = tool({
    name: 'fetch_case_record',
    description: 'Fetch the filed record for a case',
    inputSchema: z.object({
      caseId: z.string().describe('Identifier of the case to fetch'),
    }),
    callback: (input) => `...filed record for ${input.caseId}...`,
  })

  const searchPrecedent = tool({
    name: 'search_precedent',
    description: 'Search prior decisions for relevant precedent',
    inputSchema: z.object({
      question: z.string().describe('What to look for in prior decisions'),
    }),
    callback: () => '...matching prior decisions...',
  })

  // Same public entrypoint your callers already use
  async function runCase(caseId: string, prompt: string) {
    const researcher = new Agent({
      id: 'research',
      systemPrompt: 'You gather the facts of the case.',
      tools: [fetchCaseRecord],
    })
    const analyst = new Agent({
      id: 'analysis',
      systemPrompt: 'You weigh the options.',
      tools: [searchPrecedent],
    })
    const reviewer = new Agent({
      id: 'review',
      systemPrompt: 'You recommend a decision.',
    })

    const graph = new Graph({
      nodes: [researcher, analyst, reviewer],
      edges: [
        ['research', 'analysis'],
        ['analysis', 'review'],
      ],
      sources: ['research'],
      maxSteps: 10,
      // caseId is the session id: an interrupted graph resumes from it on the next call
      sessionManager: new SessionManager({
        sessionId: caseId,
        storage: new LocalFileStorage('./cases/'),
      }),
    })
    // The task text is what the model sees, so the case id is prefixed onto it.
    return graph.invoke(`Case ${caseId}: ${prompt}`)
  }

  const result = await runCase(
    'case-4127',
    'Assess the dispute and recommend a decision.'
  )
  console.log('Status:', result.status)
  console.log('Order:', result.results.map((r) => r.nodeId).join(' -> '))
  // --8<-- [end:graph_migrated]
}

// =====================
// Bounding a run: invocation limits
// =====================

async function limitsExample() {
  // --8<-- [start:limits]
  const agent = new Agent()

  const result = await agent.invoke('Summarize the case file', {
    limits: {
      turns: 5,
      outputTokens: 2000,
      totalTokens: 10000,
    },
  })

  if (result.stopReason === 'limitTurns') {
    console.log('Hit turn budget')
  } else if (result.stopReason === 'limitOutputTokens') {
    console.log('Hit output budget')
  } else if (result.stopReason === 'limitTotalTokens') {
    console.log('Hit token budget')
  }
  // --8<-- [end:limits]
}

// =====================
// Bounding a run: cancellation
// =====================

async function cancellationExample() {
  // --8<-- [start:cancellation]
  const agent = new Agent()

  // Cancel the run if it exceeds the time budget
  const result = await agent.invoke('Assess the case file', {
    cancelSignal: AbortSignal.timeout(30_000),
  })

  if (result.stopReason === 'cancelled') {
    console.log('Run cancelled: exceeded time budget')
  }
  // --8<-- [end:cancellation]
}

// =====================
// Tracing: OpenTelemetry export
// =====================

function telemetryExample() {
  // --8<-- [start:telemetry]
  // Register a tracer provider once at startup
  setupTracer({
    exporters: { otlp: true, console: true },
  })

  // Tracing turns on automatically; these attributes are added to this agent's span
  const agent = new Agent({
    systemPrompt: 'You review casework.',
    traceAttributes: { 'case.id': 'case-4127' },
  })
  // --8<-- [end:telemetry]
  void agent
}

// Suppress unused-function warnings
void migratedGraph
void limitsExample
void cancellationExample
void telemetryExample
