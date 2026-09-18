import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { McpClient, Agent } from '@strands-agents/sdk'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startTaskHTTPServer, type TaskHttpServerInfo } from '../__fixtures__/test-mcp-task-server.js'
import { startHTTPServer, type HttpServerInfo } from '../__fixtures__/test-mcp-server.js'
import { bedrock } from '../__fixtures__/model-providers.js'
import { hasToolUse, countToolResults } from '../__fixtures__/test-helpers.js'

import type { TasksConfig } from '@strands-agents/sdk'

/**
 * Creates a connected McpClient for the given server URL.
 * Returns the client - caller is responsible for disconnecting.
 * @param serverUrl - The URL of the MCP server
 * @param appName - The application name for the client
 * @param tasksConfig - Optional tasks configuration. Currently makes tool calls throw (#1659).
 */
function createClient(serverUrl: string, appName: string, tasksConfig?: TasksConfig): McpClient {
  return new McpClient({
    applicationName: appName,
    transport: new StreamableHTTPClientTransport(new URL(serverUrl)),
    ...(tasksConfig !== undefined && { tasksConfig }),
  })
}

describe('MCP Task Integration Tests', () => {
  let taskServerInfo: TaskHttpServerInfo | undefined
  let nonTaskServerInfo: HttpServerInfo | undefined

  beforeAll(async () => {
    // Start both servers in parallel
    ;[taskServerInfo, nonTaskServerInfo] = await Promise.all([startTaskHTTPServer(), startHTTPServer()])
  }, 30000)

  afterAll(async () => {
    // Clean up both servers
    await Promise.all([taskServerInfo?.close(), nonTaskServerInfo?.close()])
  }, 30000)

  // Task-augmented invocation returns with the redesigned MCP tasks extension
  // (strands-agents/harness-sdk#1659); until then a client with tasksConfig throws on callTool,
  // and the fixture's tools are registered task-only so plain calls would be rejected anyway.
  describe.skip('McpClient.callTool() with Task-Enabled Server', () => {
    it('extracts result from task tool that completes immediately', async () => {
      if (!taskServerInfo) throw new Error('Task server not started')

      const client = createClient(taskServerInfo.url, 'test-task-client', {})
      try {
        await client.connect()
        const tools = await client.listTools()
        const instantTool = tools.find((t) => t.name === 'instant_task')
        expect(instantTool).toBeDefined()

        // McpClient.callTool uses callToolStream internally
        const result = await client.callTool(instantTool!, { value: 'hello from instant task' })

        expect(result).toMatchObject({
          content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'hello from instant task' })]),
        })
      } finally {
        await client.disconnect()
      }
    }, 30000)

    it('extracts result from long-running task with progress updates', async () => {
      if (!taskServerInfo) throw new Error('Task server not started')

      const client = createClient(taskServerInfo.url, 'test-task-client', {})
      try {
        await client.connect()
        const tools = await client.listTools()
        const longRunningTool = tools.find((t) => t.name === 'long_running_task')
        expect(longRunningTool).toBeDefined()

        // McpClient.callTool should wait for the task to complete and return the final result
        const result = await client.callTool(longRunningTool!, {
          duration: 300,
          message: 'Long task completed successfully!',
        })

        expect(result).toMatchObject({
          content: expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: 'Long task completed successfully!' }),
          ]),
        })
      } finally {
        await client.disconnect()
      }
    }, 30000)

    it('throws error for failed tasks (MCP SDK behavior)', async () => {
      if (!taskServerInfo) throw new Error('Task server not started')

      const client = createClient(taskServerInfo.url, 'test-task-client', {})
      try {
        await client.connect()
        const tools = await client.listTools()
        const failingTool = tools.find((t) => t.name === 'failing_task')
        expect(failingTool).toBeDefined()

        // McpClient.callTool uses takeResult() which throws on task failure
        await expect(client.callTool(failingTool!, { error_message: 'This task failed on purpose!' })).rejects.toThrow(
          /failed/i
        )
      } finally {
        await client.disconnect()
      }
    }, 30000)
  })

  describe('McpClient.callTool() with Non-Task Server (Backward Compatibility)', () => {
    it('extracts result from regular (non-task) tools', async () => {
      if (!nonTaskServerInfo) throw new Error('Non-task server not started')

      const client = createClient(nonTaskServerInfo.url, 'test-compat-client')
      try {
        await client.connect()
        const tools = await client.listTools()
        const echoTool = tools.find((t) => t.name === 'echo')
        expect(echoTool).toBeDefined()

        const result = await client.callTool(echoTool!, { message: 'backward compat test' })

        expect(result).toMatchObject({
          content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'backward compat test' })]),
        })
      } finally {
        await client.disconnect()
      }
    }, 30000)

    it('handles calculator tool with complex arguments', async () => {
      if (!nonTaskServerInfo) throw new Error('Non-task server not started')

      const client = createClient(nonTaskServerInfo.url, 'test-compat-client')
      try {
        await client.connect()
        const tools = await client.listTools()
        const calculatorTool = tools.find((t) => t.name === 'calculator')
        expect(calculatorTool).toBeDefined()

        const result = await client.callTool(calculatorTool!, { operation: 'multiply', a: 6, b: 7 })

        expect(result).toMatchObject({
          content: expect.arrayContaining([expect.objectContaining({ type: 'text', text: 'Result: 42' })]),
        })
      } finally {
        await client.disconnect()
      }
    }, 30000)
  })

  // Skipped for the same reason as the task-enabled callTool suite above (#1659).
  describe.skip('Agent Integration with Task Tools', () => {
    it('agent can use task tools in a conversation', async () => {
      if (!taskServerInfo) throw new Error('Task server not started')

      const client = createClient(taskServerInfo.url, 'test-agent-task-client', {})
      try {
        const model = bedrock.createModel({ maxTokens: 300 })
        const agent = new Agent({
          systemPrompt:
            'You are a helpful assistant. When asked to run a task, use the instant_task tool with the value provided by the user.',
          tools: [client],
          model,
        })

        const result = await agent.invoke('Please run an instant task with the value "agent test message"')

        expect(result).toBeDefined()
        expect(result.stopReason).toBeDefined()
        expect(hasToolUse(agent.messages, 'instant_task')).toBe(true)
        expect(countToolResults(agent.messages, 'success')).toBeGreaterThan(0)
      } finally {
        await client.disconnect()
      }
    }, 60000)

    it('agent handles task tool errors gracefully', async () => {
      if (!taskServerInfo) throw new Error('Task server not started')

      const client = createClient(taskServerInfo.url, 'test-agent-task-client', {})
      try {
        const model = bedrock.createModel({ maxTokens: 300 })
        const agent = new Agent({
          systemPrompt: 'You are a helpful assistant. When asked to test error handling, use the failing_task tool.',
          tools: [client],
          model,
        })

        const result = await agent.invoke('Please use the failing_task tool to test error handling.')

        expect(result).toBeDefined()
        expect(hasToolUse(agent.messages, 'failing_task')).toBe(true)
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThan(0)
      } finally {
        await client.disconnect()
      }
    }, 60000)

    it('agent can use multiple task tools in a multi-turn conversation', async () => {
      if (!taskServerInfo) throw new Error('Task server not started')

      const client = createClient(taskServerInfo.url, 'test-agent-multi-task-client', {})
      try {
        const model = bedrock.createModel({ maxTokens: 300 })
        const agent = new Agent({
          systemPrompt:
            'You are a helpful assistant. Use task tools when requested. Available tools: instant_task (quick), long_running_task (takes time).',
          tools: [client],
          model,
        })

        // First turn: use instant_task
        await agent.invoke('Run an instant task with value "first turn"')
        expect(hasToolUse(agent.messages, 'instant_task')).toBe(true)

        // Second turn: use long_running_task
        await agent.invoke('Now run a long running task with message "second turn complete"')
        expect(hasToolUse(agent.messages, 'long_running_task')).toBe(true)

        // Both tool results should be successful
        expect(countToolResults(agent.messages, 'success')).toBeGreaterThanOrEqual(2)
      } finally {
        await client.disconnect()
      }
    }, 90000)
  })
})
