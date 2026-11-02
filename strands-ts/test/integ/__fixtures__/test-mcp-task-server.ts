import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js'
import type { TaskStore, CreateTaskOptions } from '@modelcontextprotocol/sdk/experimental/tasks/interfaces.js'
import type { CallToolResult, Task, Request, RequestId, Result } from '@modelcontextprotocol/sdk/types.js'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import * as z from 'zod'

/** Context stored with long_running_task */
interface LongRunningContext extends Record<string, unknown> {
  type: 'long_running'
  startTime: number
  duration: number
  message: string
}

/** Context stored with instant_task */
interface InstantContext extends Record<string, unknown> {
  type: 'instant'
  value: string
}

/** Context stored with failing_task */
interface FailingContext extends Record<string, unknown> {
  type: 'failing'
  startTime: number
  errorMessage: string
}

type TaskContext = LongRunningContext | InstantContext | FailingContext

/**
 * Calculate task status message based on progress for long_running_task
 */
function getProgressMessage(elapsed: number, duration: number): string {
  const progress = elapsed / duration
  if (progress < 0.33) return 'Step 1: Initializing...'
  if (progress < 0.66) return 'Step 2: Processing...'
  return 'Step 3: Finalizing...'
}

/**
 * Custom TaskStore that computes task status statelessly on getTask calls.
 *
 * This works around two issues in the MCP SDK:
 * 1. Custom getTask/getTaskResult handlers registered via registerToolTask are bypassed
 *    by the Protocol class. See: https://github.com/modelcontextprotocol/typescript-sdk/pull/1335
 * 2. InMemoryTaskStore doesn't store the `context` field from CreateTaskOptions
 *
 * By storing context ourselves and computing status in getTask(), we ensure proper behavior.
 */
class StatelessTaskStore implements TaskStore {
  private _delegate: InMemoryTaskStore
  private _contexts: Map<string, TaskContext> = new Map()

  constructor() {
    this._delegate = new InMemoryTaskStore()
  }

  cleanup(): void {
    this._delegate.cleanup()
    this._contexts.clear()
  }

  async createTask(
    taskParams: CreateTaskOptions,
    requestId: RequestId,
    request: Request,
    sessionId?: string
  ): Promise<Task> {
    const task = await this._delegate.createTask(taskParams, requestId, request, sessionId)
    // Store context separately since InMemoryTaskStore doesn't store it
    if (taskParams.context) {
      this._contexts.set(task.taskId, taskParams.context as TaskContext)
    }
    return task
  }

  async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string
  ): Promise<void> {
    return this._delegate.updateTaskStatus(taskId, status, statusMessage, sessionId)
  }

  async storeTaskResult(
    taskId: string,
    status: 'completed' | 'failed',
    result: Result,
    sessionId?: string
  ): Promise<void> {
    return this._delegate.storeTaskResult(taskId, status, result, sessionId)
  }

  async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    // First compute the status (which may complete the task)
    await this.getTask(taskId, sessionId)
    return this._delegate.getTaskResult(taskId, sessionId)
  }

  async listTasks(cursor?: string, sessionId?: string): Promise<{ tasks: Task[]; nextCursor?: string }> {
    return this._delegate.listTasks(cursor, sessionId)
  }

  /**
   * Override getTask to compute status from elapsed time for time-based tasks.
   */
  async getTask(taskId: string, sessionId?: string): Promise<Task | null> {
    const task = await this._delegate.getTask(taskId, sessionId)
    if (!task) return task

    // Get context from our separate store
    const ctx = this._contexts.get(taskId)
    if (!ctx) return task

    // Handle long_running_task: calculate status from elapsed time
    if (ctx.type === 'long_running') {
      const elapsed = Date.now() - ctx.startTime
      if (elapsed >= ctx.duration) {
        // Task is done - mark completed
        if (task.status !== 'completed') {
          await this._delegate.storeTaskResult(taskId, 'completed', {
            content: [{ type: 'text', text: ctx.message }],
          })
        }
      } else {
        // Still working - update status message
        await this._delegate.updateTaskStatus(taskId, 'working', getProgressMessage(elapsed, ctx.duration))
      }
      return await this._delegate.getTask(taskId, sessionId)
    }

    // Handle failing_task: fail after delay
    if (ctx.type === 'failing') {
      const elapsed = Date.now() - ctx.startTime
      const failDelay = 60 // ms before failing

      if (elapsed >= failDelay) {
        // Time to fail
        if (task.status !== 'failed') {
          await this._delegate.storeTaskResult(taskId, 'failed', {
            content: [{ type: 'text', text: ctx.errorMessage }],
            isError: true,
          })
        }
      } else {
        // Still "working" before failure
        await this._delegate.updateTaskStatus(taskId, 'working', 'About to fail...')
      }
      return await this._delegate.getTask(taskId, sessionId)
    }

    // instant_task and others: no special handling needed
    return task
  }
}

/**
 * Creates a test MCP server with task-enabled tools using the high-level API.
 *
 * Note: Due to an MCP SDK bug (https://github.com/modelcontextprotocol/typescript-sdk/pull/1335),
 * custom getTask/getTaskResult handlers are bypassed. Status calculation is done in
 * StatelessTaskStore.getTask() instead.
 */
function createTaskTestServer(taskStore: StatelessTaskStore): McpServer {
  const server = new McpServer(
    { name: 'test-mcp-task-server', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        tasks: {
          requests: {
            tools: { call: {} },
          },
        },
      },
      taskStore,
    }
  )

  // Register long_running_task - stores context with timing info
  // Status calculation happens in StatelessTaskStore.getTask()
  server.experimental.tasks.registerToolTask(
    'long_running_task',
    {
      description: 'Simulates a long-running task with progress updates',
      inputSchema: {
        duration: z.number().optional().describe('Duration in milliseconds (default: 200)'),
        message: z.string().optional().describe('Message to include in result'),
      },
    },
    {
      async createTask({ duration, message }, { taskStore: store }) {
        const context: LongRunningContext = {
          type: 'long_running',
          startTime: Date.now(),
          duration: duration ?? 200,
          message: message ?? 'Task completed!',
        }
        const task = await store.createTask({ ttl: 60000, pollInterval: 50, context })
        return { task }
      },

      async getTask(_args, { taskId, taskStore: store }) {
        return await store.getTask(taskId)
      },

      async getTaskResult(_args, { taskId, taskStore: store }) {
        const result = await store.getTaskResult(taskId)
        return result as CallToolResult
      },
    }
  )

  // Register instant_task - completes immediately on creation
  server.experimental.tasks.registerToolTask(
    'instant_task',
    {
      description: 'A task that completes immediately',
      inputSchema: {
        value: z.string().optional().describe('Value to return'),
      },
    },
    {
      async createTask({ value }, { taskStore: store }) {
        const context: InstantContext = {
          type: 'instant',
          value: value ?? 'instant result',
        }
        const task = await store.createTask({ ttl: 60000, pollInterval: 50, context })
        // Complete immediately
        await store.storeTaskResult(task.taskId, 'completed', {
          content: [{ type: 'text', text: context.value }],
        })
        return { task }
      },

      async getTask(_args, { taskId, taskStore: store }) {
        return await store.getTask(taskId)
      },

      async getTaskResult(_args, { taskId, taskStore: store }) {
        const result = await store.getTaskResult(taskId)
        return result as CallToolResult
      },
    }
  )

  // Register failing_task - stores context with timing info
  // Failure logic happens in StatelessTaskStore.getTask()
  server.experimental.tasks.registerToolTask(
    'failing_task',
    {
      description: 'A task that always fails for error handling testing',
      inputSchema: {
        error_message: z.string().optional().describe('Error message to return'),
      },
    },
    {
      async createTask({ error_message }, { taskStore: store }) {
        const context: FailingContext = {
          type: 'failing',
          startTime: Date.now(),
          errorMessage: error_message ?? 'Task intentionally failed',
        }
        const task = await store.createTask({ ttl: 60000, pollInterval: 50, context })
        return { task }
      },

      async getTask(_args, { taskId, taskStore: store }) {
        return await store.getTask(taskId)
      },

      async getTaskResult(_args, { taskId, taskStore: store }) {
        const result = await store.getTaskResult(taskId)
        return result as CallToolResult
      },
    }
  )

  return server
}

/**
 * Interface for HTTP-based server info
 */
export interface TaskHttpServerInfo {
  server: HttpServer
  port: number
  url: string
  close: () => Promise<void>
}

/**
 * Creates and starts a task-enabled Streamable HTTP MCP server on a random port.
 * Creates a new McpServer per request while sharing the taskStore.
 */
export async function startTaskHTTPServer(): Promise<TaskHttpServerInfo> {
  const taskStore = new StatelessTaskStore()

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/mcp' && req.method === 'POST') {
      try {
        // Read request body
        let body = ''
        await new Promise<void>((resolve) => {
          req.on('data', (chunk) => {
            body += chunk.toString()
          })
          req.on('end', () => {
            resolve()
          })
        })

        const parsedBody = body ? JSON.parse(body) : undefined

        // Create a new server and transport for each request
        // The taskStore is shared across all requests to persist task state
        const mcpServer = createTaskTestServer(taskStore)
        const transport = new StreamableHTTPServerTransport({
          enableJsonResponse: true,
        })

        res.on('close', async () => {
          await transport.close()
        })

        await mcpServer.connect(transport)
        await transport.handleRequest(req, res, parsedBody)
      } catch (error) {
        console.error('Error handling MCP request:', error)
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: {
                code: -32603,
                message: 'Internal server error',
              },
              id: null,
            })
          )
        }
      }
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  return new Promise((resolve) => {
    httpServer.listen(0, () => {
      const address = httpServer.address() as AddressInfo
      const port = address.port
      const url = `http://localhost:${port}/mcp`

      resolve({
        server: httpServer,
        port,
        url,
        close: async () => {
          taskStore.cleanup()
          return new Promise((resolveClose) => {
            httpServer.close(() => {
              resolveClose()
            })
          })
        },
      })
    })
  })
}

// Start the stdio server when this file is run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const taskStore = new StatelessTaskStore()
  const server = createTaskTestServer(taskStore)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
