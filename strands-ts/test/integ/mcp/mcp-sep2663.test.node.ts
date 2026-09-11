import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest'
import { McpClient, Agent } from '@strands-agents/sdk'
import { resolve } from 'node:path'
import { MockMessageModel } from '$/sdk/__fixtures__/mock-message-model.js'
import { startTaskHTTPServer, type TaskHttpServerInfo } from '../__fixtures__/test-mcp-sep2663-server.js'
import { bedrock } from '../__fixtures__/model-providers.js'
import { hasToolUse, countToolResults, getToolResultText } from '../__fixtures__/test-helpers.js'

import type { ElicitationCallback, TasksConfig } from '@strands-agents/sdk'

const MODERN_PROTOCOL_VERSION = '2026-07-28'

function createClient(serverUrl: string, appName: string, tasksConfig?: TasksConfig): McpClient {
  const client = new McpClient({
    applicationName: appName,
    url: serverUrl,
    ...(tasksConfig !== undefined && { tasksConfig }),
  })
  onTestFinished(() => client.disconnect())
  return client
}

describe('MCP SEP-2663 Integration Tests', () => {
  let taskServerInfo: TaskHttpServerInfo | undefined

  beforeAll(async () => {
    taskServerInfo = await startTaskHTTPServer()
  }, 30000)

  afterAll(async () => {
    await taskServerInfo?.close()
  }, 30000)

  describe('McpClient.callTool() with Task-Enabled Server', () => {
    it('preserves direct tool results when task support is enabled', async () => {
      const serverInfo = await startTaskHTTPServer()
      onTestFinished(() => serverInfo.close())

      const client = createClient(serverInfo.url, 'test-direct-result-client', {})
      const tools = await client.listTools()
      const directTool = tools.find((tool) => tool.name === 'direct_result')
      if (!directTool) throw new Error('direct_result tool not found')

      await expect(client.callTool(directTool, { value: 'direct response' })).resolves.toMatchObject({
        content: [{ type: 'text', text: 'direct response' }],
      })
      expect(serverInfo.requests.filter((request) => request.method === 'tasks/get')).toEqual([])
    }, 30000)

    it('returns a task handle without polling and supports explicit lifecycle operations', async () => {
      const serverInfo = await startTaskHTTPServer()
      onTestFinished(() => serverInfo.close())

      const client = createClient(serverInfo.url, 'test-task-lifecycle-client', {
        useNotifications: false,
      })
      const tools = await client.listTools()
      const cancellableTool = tools.find((tool) => tool.name === 'cancellable_task')
      if (!cancellableTool) throw new Error('cancellable_task tool not found')
      const requestStart = serverInfo.requests.length

      const task = await client.callToolWithTask(cancellableTool, { message: 'waiting' })
      expect(task).toMatchObject({
        resultType: 'task',
        status: 'working',
        statusMessage: 'waiting',
      })
      if (task.resultType !== 'task' || typeof task.taskId !== 'string') {
        throw new Error('Expected a task handle')
      }
      const taskId = task.taskId

      expect(serverInfo.requests.slice(requestStart).filter((request) => request.method === 'tasks/get')).toEqual([])
      await expect(client.getTask(taskId)).resolves.toMatchObject({
        taskId,
        status: 'working',
      })
      await expect(client.cancelTask(taskId)).resolves.toEqual({
        resultType: 'complete',
        _meta: expect.any(Object),
      })
      await expect(client.getTask(taskId)).resolves.toMatchObject({
        taskId,
        status: 'cancelled',
      })

      expect(
        serverInfo.requests
          .slice(requestStart)
          .filter((request) => request.method.startsWith('tasks/'))
          .map(({ method, taskId, mcpMethod, mcpName, protocolVersion }) => ({
            method,
            taskId,
            mcpMethod,
            mcpName,
            protocolVersion,
          }))
      ).toEqual(
        ['tasks/get', 'tasks/cancel', 'tasks/get'].map((method) => ({
          method,
          taskId,
          mcpMethod: method,
          mcpName: taskId,
          protocolVersion: MODERN_PROTOCOL_VERSION,
        }))
      )
    }, 30000)

    it.each([
      {
        name: 'instant_task',
        input: { value: 'hello from instant task' },
        text: 'hello from instant task',
      },
      {
        name: 'long_running_task',
        input: { duration: 300, message: 'Long task completed successfully!' },
        text: 'Long task completed successfully!',
      },
    ])(
      'extracts result from $name',
      async ({ name, input, text }) => {
        if (!taskServerInfo) throw new Error('Task server not started')

        const client = createClient(taskServerInfo.url, 'test-task-client', {})
        await client.connect()
        const tools = await client.listTools()
        const taskTool = tools.find((tool) => tool.name === name)
        expect(taskTool).toBeDefined()

        await expect(client.callTool(taskTool!, input)).resolves.toMatchObject({
          content: [{ type: 'text', text }],
        })
      },
      30000
    )

    it('throws error for failed tasks (MCP SDK behavior)', async () => {
      if (!taskServerInfo) throw new Error('Task server not started')

      const client = createClient(taskServerInfo.url, 'test-task-client', {})
      await client.connect()
      const tools = await client.listTools()
      const failingTool = tools.find((t) => t.name === 'failing_task')
      expect(failingTool).toBeDefined()

      await expect(client.callTool(failingTool!, { error_message: 'This task failed on purpose!' })).rejects.toThrow(
        /failed/i
      )
    }, 30000)

    it('handles task elicitation through tasks/update and returns the final result', async () => {
      const serverInfo = await startTaskHTTPServer()
      onTestFinished(() => serverInfo.close())

      const elicitationCallback: ElicitationCallback = vi.fn().mockResolvedValue({
        action: 'accept',
        content: { value: 'integration answer' },
      })
      const client = new McpClient({
        applicationName: 'test-task-elicitation-client',
        url: serverInfo.url,
        tasksConfig: {
          pollIntervalMs: 10,
          timeoutMs: 5_000,
        },
        elicitationCallback,
      })
      try {
        const tools = await client.listTools()
        const inputTool = tools.find((tool) => tool.name === 'input_required_task')
        if (!inputTool) throw new Error('input_required_task tool not found')
        const requestStart = serverInfo.requests.length

        await expect(client.callTool(inputTool, { prompt: 'Provide integration input' })).resolves.toMatchObject({
          content: [{ type: 'text', text: 'Input received: integration answer' }],
        })
        expect(elicitationCallback).toHaveBeenCalledOnce()
        const updateRequests = serverInfo.requests
          .slice(requestStart)
          .filter((request) => request.method === 'tasks/update')
        expect(updateRequests).toHaveLength(1)
        expect(updateRequests[0]).toEqual(
          expect.objectContaining({
            method: 'tasks/update',
            taskId: expect.any(String),
            mcpMethod: 'tasks/update',
            mcpName: updateRequests[0]!.taskId,
            protocolVersion: MODERN_PROTOCOL_VERSION,
          })
        )
      } finally {
        await client.disconnect()
      }
    }, 30000)

    it('translates a server-cancelled task consistently', async () => {
      if (!taskServerInfo) throw new Error('Task server not started')

      const client = createClient(taskServerInfo.url, 'test-cancelled-task-client', {
        useNotifications: false,
      })
      const tools = await client.listTools()
      const cancelledTool = tools.find((tool) => tool.name === 'cancelled_task')
      if (!cancelledTool) throw new Error('cancelled_task tool not found')

      await expect(client.callTool(cancelledTool, { reason: 'Cancelled by integration fixture' })).rejects.toEqual(
        expect.objectContaining({
          name: 'McpTaskCancelledError',
          statusMessage: 'Cancelled by integration fixture',
        })
      )
    }, 30000)
  })

  describe('McpClient.loadServers()', () => {
    it('loads HTTP and stdio servers with task defaults and the elicitation callback', async () => {
      if (!taskServerInfo) throw new Error('Task server not started')

      const elicitationCallback: ElicitationCallback = vi
        .fn()
        .mockResolvedValueOnce({ action: 'accept', content: { value: 'loaded client answer' } })
        .mockResolvedValueOnce({ action: 'accept', content: { confirmed: true } })
      const clients = await McpClient.loadServers(
        {
          loaded: {
            url: taskServerInfo.url,
            toolFilters: { allowed: ['^input_required_task$'] },
          },
          stdio: {
            command: process.execPath,
            args: ['--import', 'tsx', resolve('test/integ/__fixtures__/test-mcp-v2-server.ts')],
            toolFilters: { allowed: ['^confirm_action$'] },
          },
        },
        {
          tasksConfig: { timeoutMs: 5_000, ttl: 1_000, useNotifications: false },
          elicitationCallback,
        },
        { prefixWithServerName: true }
      )
      try {
        expect(clients).toEqual([expect.any(McpClient), expect.any(McpClient)])
        const client = clients[0]!
        const tools = await client.listTools()
        expect(client.client.getProtocolEra()).toBe('modern')
        expect(tools.map((tool) => tool.name)).toEqual(['loaded_input_required_task'])
        await expect(client.callTool(tools[0]!, { prompt: 'Loaded task input' })).resolves.toMatchObject({
          content: [{ type: 'text', text: 'Input received: loaded client answer' }],
        })

        const stdioClient = clients[1]!
        const stdioTools = await stdioClient.listTools()
        expect(stdioClient.client.getProtocolEra()).toBe('modern')
        expect(stdioTools.map((tool) => tool.name)).toEqual(['stdio_confirm_action'])
        await expect(stdioClient.callTool(stdioTools[0]!, { action: 'loaded stdio action' })).resolves.toMatchObject({
          content: [{ type: 'text', text: 'Action "loaded stdio action" confirmed by user' }],
        })

        expect(vi.mocked(elicitationCallback).mock.calls).toEqual([
          [
            expect.objectContaining({
              mcpReq: expect.objectContaining({ id: expect.stringMatching(/^task:/), signal: expect.any(AbortSignal) }),
            }),
            expect.objectContaining({ message: 'Loaded task input' }),
          ],
          [
            expect.objectContaining({
              mcpReq: expect.objectContaining({ id: 'confirmation', signal: expect.any(AbortSignal) }),
            }),
            expect.objectContaining({ message: 'Do you want to proceed with: loaded stdio action?' }),
          ],
        ])
      } finally {
        await Promise.all(clients.map((client) => client.disconnect()))
      }
    })
  })

  describe('Agent Integration with Task Tools', () => {
    it('agent can use task tools in a conversation with a live model', async () => {
      if (!taskServerInfo) throw new Error('Task server not started')

      const client = createClient(taskServerInfo.url, 'test-agent-task-client', {})
      const model = bedrock.createModel({ maxTokens: 300 })
      const agent = new Agent({
        systemPrompt:
          'You are a helpful assistant. When asked to run a task, use the instant_task tool with the value provided by the user.',
        tools: [client],
        model,
      })

      const result = await agent.invoke('Please run an instant task with the value "agent test message"')

      expect(result.stopReason).toBeDefined()
      expect(hasToolUse(agent.messages, 'instant_task')).toBe(true)
      expect(countToolResults(agent.messages, 'success')).toBeGreaterThan(0)
    }, 60000)

    it('agent handles task tool errors gracefully', async () => {
      if (!taskServerInfo) throw new Error('Task server not started')

      const client = createClient(taskServerInfo.url, 'test-agent-task-client', {})
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'failing_task', toolUseId: 'failed-task', input: {} })
        .addTurn({ type: 'textBlock', text: 'Task error handled' })
      const agent = new Agent({ tools: [client], model })

      await expect(agent.invoke('Test task error handling')).resolves.toMatchObject({ stopReason: 'endTurn' })
      expect(hasToolUse(agent.messages, 'failing_task')).toBe(true)
      expect(countToolResults(agent.messages, 'error')).toBe(1)
    }, 60000)

    it('agent can use multiple task tools in a multi-turn conversation', async () => {
      if (!taskServerInfo) throw new Error('Task server not started')

      const client = createClient(taskServerInfo.url, 'test-agent-multi-task-client', {})
      const model = new MockMessageModel()
      const agent = new Agent({ tools: [client], model })
      for (const { name, input } of [
        { name: 'instant_task', input: { value: 'first turn' } },
        { name: 'long_running_task', input: { message: 'second turn complete' } },
      ]) {
        model
          .addTurn({ type: 'toolUseBlock', name, toolUseId: name, input })
          .addTurn({ type: 'textBlock', text: 'Done' })
        await expect(agent.invoke(`Run ${name}`)).resolves.toMatchObject({ stopReason: 'endTurn' })
        expect(hasToolUse(agent.messages, name)).toBe(true)
      }

      expect(countToolResults(agent.messages, 'success')).toBe(2)
      expect(getToolResultText(agent.messages)).toBe('first turn second turn complete')
    }, 90000)
  })
})
