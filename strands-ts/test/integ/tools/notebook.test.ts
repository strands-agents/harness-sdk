import { describe, expect, it } from 'vitest'
import type { AgentResult, AgentStreamEvent } from '$/sdk/index.js'
import { Agent } from '$/sdk/index.js'
import { notebook } from '$/sdk/vended-tools/notebook/index.js'
import { collectGenerator } from '$/sdk/__fixtures__/model-test-helpers.js'
import { bedrock } from '../__fixtures__/model-providers.js'

describe.skipIf(bedrock.skip)('Notebook Tool Integration', () => {
  // Shared agent configuration for all tests
  const agentParams = {
    model: bedrock.createModel({
      region: 'us-east-1',
    }),
    tools: [notebook],
  }

  it('should persist notebook state across tool invocations', async () => {
    // Create agent with notebook tool
    const agent = new Agent(agentParams)

    // Step 1: Create a notebook
    const { items: _events1 } = await collectGenerator(
      agent.stream('Create a notebook called "test" with content "# Test Notebook"')
    )

    // Verify notebook was created
    const notebooks1 = agent.appState.get('notebooks') as any
    expect(notebooks1).toBeTruthy()
    expect(notebooks1).toHaveProperty('test')
    expect(notebooks1.test).toContain('# Test Notebook')

    // Step 2: Add content to the notebook
    const { items: _events2 } = await collectGenerator(agent.stream('Add "- First item" to the test notebook'))

    // Verify content was added
    const notebooks2 = agent.appState.get('notebooks') as any
    expect(notebooks2.test).toContain('- First item')

    // Step 3: Read the notebook
    const { items: events3 } = await collectGenerator<AgentStreamEvent, AgentResult>(
      agent.stream('Read the test notebook')
    )

    // Find the last content block complete event with a text block to get agent's response
    const textBlocks = events3.filter((e) => e.type === 'contentBlockEvent' && e.contentBlock.type === 'textBlock')
    expect(textBlocks.length).toBeGreaterThan(0)

    // The notebook should still contain both pieces of content
    const notebooks3 = agent.appState.get('notebooks') as any
    expect(notebooks3.test).toContain('# Test Notebook')
    expect(notebooks3.test).toContain('- First item')
  }, 30000) // 30 second timeout for network calls

  it('should restore state across agent instances', async () => {
    // Create first agent and add content
    const agent1 = new Agent(agentParams)

    // Create notebook with first agent
    await collectGenerator(agent1.stream('Create a notebook called "persist" with "Persistent content"'))

    // Verify notebook was created
    const notebooks1 = agent1.appState.get('notebooks') as any
    expect(notebooks1).toBeTruthy()
    expect(notebooks1.persist).toContain('Persistent content')

    // Save state
    const savedState = agent1.appState.getAll()

    // Create second agent with restored state
    const agent2 = new Agent({
      ...agentParams,
      appState: savedState, // Pass state in constructor
    })

    // Verify notebooks were restored
    const notebooks2 = agent2.appState.get('notebooks') as any
    expect(notebooks2).toBeTruthy()
    expect(notebooks2.persist).toContain('Persistent content')

    // Use the restored notebook - just read it
    await collectGenerator(agent2.stream('Read the persist notebook'))

    // Verify content still exists
    const notebooks3 = agent2.appState.get('notebooks') as any
    expect(notebooks3.persist).toContain('Persistent content')
  }, 30000)

  it('should handle errors gracefully', async () => {
    const agent = new Agent(agentParams)

    // Try to read non-existent notebook
    const { items: events } = await collectGenerator(agent.stream('Read a notebook called "nonexistent"'))

    // The agent should handle the error and provide a reasonable response
    // Check that we got tool result events (indicating tool was called)
    const toolResults = events.filter((e) => e.type === 'toolResultEvent')
    expect(toolResults.length).toBeGreaterThan(0)

    // The model should have handled the error gracefully
    const textBlocks = events.filter((e) => e.type === 'contentBlockEvent' && e.contentBlock.type === 'textBlock')
    expect(textBlocks.length).toBeGreaterThan(0)
  }, 30000)
})
