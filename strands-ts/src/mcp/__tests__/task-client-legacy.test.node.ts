import { InMemoryTransport, type JSONRPCMessage } from '@modelcontextprotocol/client'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  InMemoryTaskStore,
  InMemoryTaskMessageQueue,
} from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { McpClient } from '../client.js'

describe('McpClient legacy task server', () => {
  it('fulfills queued legacy task input and cancels an aborted task through the SDK2 client', async () => {
    const store = new InMemoryTaskStore()
    const background: Promise<void>[] = []
    const sent: JSONRPCMessage[] = []
    let pendingTaskId: string | undefined
    let elicitationCount = 0
    const server = new Server(
      { name: 'legacy-task-fixture', version: '1' },
      {
        capabilities: { tools: {}, tasks: { cancel: {}, requests: { tools: { call: {} } } } },
        taskStore: store,
        taskMessageQueue: new InMemoryTaskMessageQueue(),
      }
    )
    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: ['input_task', 'pending_task'].map((name) => ({
        name,
        inputSchema: { type: 'object' as const },
        execution: { taskSupport: 'required' as const },
      })),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      if (!extra.taskStore) throw new Error('Task storage was not initialized')
      const task = await extra.taskStore.createTask({ ttl: 5_000, pollInterval: 10 })
      if (request.params.name === 'pending_task') {
        pendingTaskId = task.taskId
        return { task }
      }
      await store.updateTaskStatus(task.taskId, 'input_required')
      // tools/call must return the handle before tasks/result can drain the queued request.
      const job = server
        .request(
          {
            method: 'elicitation/create',
            params: {
              message: 'Provide a value',
              requestedSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            },
          },
          ElicitResultSchema,
          { relatedTask: { taskId: task.taskId }, timeout: 1_000 }
        )
        .then(async (answer) => {
          await store.storeTaskResult(task.taskId, 'completed', {
            content: [{ type: 'text', text: answer.content?.value }],
          })
        })
      background.push(job)
      void job.catch(() => undefined)
      return { task }
    })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const send = clientTransport.send.bind(clientTransport)
    clientTransport.send = async (message, options): Promise<void> => {
      sent.push(message)
      await send(message, options)
    }
    const client = new McpClient({
      transport: clientTransport,
      prefix: 'legacy',
      tasksConfig: { ttl: 1_000, timeoutMs: 3_000 },
      elicitationCallback: async (context) => {
        expect(context.mcpReq.signal.aborted).toBe(false)
        elicitationCount++
        return { action: 'accept', content: { value: 'accepted' } }
      },
    })

    try {
      await server.connect(serverTransport)
      const tools = await client.listTools()
      const inputTool = tools.find((tool) => tool.name === 'legacy_input_task')!
      await expect(client.callTool(inputTool, {})).resolves.toMatchObject({
        content: [{ type: 'text', text: 'accepted' }],
      })
      expect(elicitationCount).toBe(1)
      expect(sent.some((message) => 'method' in message && message.method === 'tasks/result')).toBe(true)
      await Promise.all(background)

      const pendingTool = tools.find((tool) => tool.name === 'legacy_pending_task')!
      const controller = new AbortController()
      const reason = new Error('caller stopped')
      const rejected = expect(client.callTool(pendingTool, {}, { signal: controller.signal })).rejects.toBe(reason)
      await expect
        .poll(() =>
          sent.some(
            (message) =>
              'method' in message && message.method === 'tasks/get' && message.params?.taskId === pendingTaskId
          )
        )
        .toBe(true)
      controller.abort(reason)
      await rejected
      await expect
        .poll(async () => (pendingTaskId ? (await store.getTask(pendingTaskId))?.status : undefined))
        .toBe('cancelled')
      expect(sent.filter((message) => 'method' in message && message.method === 'tasks/cancel')).toHaveLength(1)
    } finally {
      await client.disconnect()
      await server.close()
      await Promise.allSettled(background)
      store.cleanup()
    }
  })
})
