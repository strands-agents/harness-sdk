import { Agent, Graph, SessionManager } from '@strands-agents/sdk'
import { LocalFileStorage } from '@strands-agents/sdk/storage'
import { setupTracer } from '@strands-agents/sdk/telemetry'

// =====================
// Worked example: the casework graph, migrated
// =====================

async function migratedGraph() {
  // --8<-- [start:graph_migrated]
  // Same public entrypoint your callers already use
  async function runCase(caseId: string, prompt: string) {
    const researcher = new Agent({
      id: 'research',
      systemPrompt: 'You gather the facts of the case from the record.',
    })
    const analyst = new Agent({
      id: 'analysis',
      systemPrompt: 'You weigh the options against the facts.',
    })
    const reviewer = new Agent({
      id: 'review',
      systemPrompt: 'You review the analysis and recommend a decision.',
    })

    const graph = new Graph({
      nodes: [researcher, analyst, reviewer],
      edges: [
        ['research', 'analysis'],
        ['analysis', 'review'],
      ],
      sources: ['research'],
      // caseId is the session id: the graph restores prior state on the next call
      sessionManager: new SessionManager({
        sessionId: caseId,
        storage: new LocalFileStorage('./cases/'),
      }),
    })
    return graph.invoke(prompt)
  }

  const result = await runCase('case-4127', 'Assess the tenant dispute in the record.')
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

  // Tracing turns on automatically; attach attributes to every span
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
