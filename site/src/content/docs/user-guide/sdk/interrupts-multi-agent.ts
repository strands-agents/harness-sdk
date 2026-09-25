// @ts-nocheck
// NOTE: Type-checking is disabled because the interrupt feature is not yet published in the installed SDK.

import { Agent, BeforeNodeCallEvent, Graph, Swarm, Status } from '@strands-agents/sdk'

// =====================
// Swarm BeforeNodeCallEvent Example
// =====================

async function swarmBeforeNodeCallExample() {
  // --8<-- [start:multiagent_swarm]
  const cleanupAgent = new Agent({
    id: 'cleanup',
    systemPrompt: 'You clean up resources older than 5 days.',
  })

  const swarm = new Swarm({ nodes: [cleanupAgent], start: 'cleanup' })

  swarm.addHook(BeforeNodeCallEvent, (event) => {
    if (event.nodeId !== 'cleanup') return

    const approval = event.interrupt<string>({
      name: 'myapp-approval',
      reason: { resources: 'example' },
    })
    if (approval.toLowerCase() !== 'y') {
      event.cancel = 'User denied permission to cleanup resources'
    }
  })

  let result = await swarm.invoke('Clean up my resources')

  while (result.status === Status.INTERRUPTED) {
    const responses = result.interrupts!.map((interrupt) => ({
      interruptResponse: {
        interruptId: interrupt.id,
        // In a real app, collect user input here
        response: 'y',
      },
    }))

    result = await swarm.invoke(responses)
  }

  console.log('MESSAGE:', JSON.stringify(result.results, null, 2))
  // --8<-- [end:multiagent_swarm]
}

// =====================
// Graph BeforeNodeCallEvent Example
// =====================

async function graphBeforeNodeCallExample() {
  // --8<-- [start:multiagent_graph]
  const inspectorAgent = new Agent({
    id: 'inspector',
    systemPrompt: 'You inspect resources.',
  })
  const cleanupAgent = new Agent({
    id: 'cleanup',
    systemPrompt: 'You clean up resources older than 5 days.',
  })

  const graph = new Graph({
    nodes: [inspectorAgent, cleanupAgent],
    edges: [['inspector', 'cleanup']],
  })

  graph.addHook(BeforeNodeCallEvent, (event) => {
    if (event.nodeId !== 'cleanup') return

    const approval = event.interrupt<string>({
      name: 'myapp-approval',
      reason: { resources: 'example' },
    })
    if (approval.toLowerCase() !== 'y') {
      event.cancel = 'User denied permission to cleanup resources'
    }
  })

  let result = await graph.invoke('Inspect and clean up my resources')

  while (result.status === Status.INTERRUPTED) {
    const responses = result.interrupts!.map((interrupt) => ({
      interruptResponse: {
        interruptId: interrupt.id,
        // In a real app, collect user input here
        response: 'y',
      },
    }))

    result = await graph.invoke(responses)
  }

  console.log('MESSAGE:', JSON.stringify(result.results, null, 2))
  // --8<-- [end:multiagent_graph]
}

// Suppress unused function warnings
void swarmBeforeNodeCallExample
void graphBeforeNodeCallExample
