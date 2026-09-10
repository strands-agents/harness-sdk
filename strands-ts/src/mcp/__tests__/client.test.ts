import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js'
import {
  McpError,
  ErrorCode,
  ElicitRequestSchema,
  UrlElicitationRequiredError,
} from '@modelcontextprotocol/sdk/types.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ClientCredentialsProvider } from '@modelcontextprotocol/sdk/client/auth-extensions.js'
import { McpClient } from '../client.js'
import { McpTool } from '../../tools/mcp-tool.js'
import { JsonBlock, type TextBlock, type ToolResultBlock } from '../../types/messages.js'
import { ImageBlock } from '../../types/media.js'
import type { LocalAgent } from '../../types/agent.js'
import type { ToolContext } from '../../tools/tool.js'
import type { ElicitationCallback } from '../../types/elicitation.js'
import { context, propagation, trace, TraceFlags } from '@opentelemetry/api'
import type { SpanContext } from '@opentelemetry/api'
import { logger } from '../../logging/index.js'
import type { LoggingMessageNotificationParams } from '@modelcontextprotocol/sdk/types.js'

/**
 * Helper to create a mock async generator that yields a result message.
 * This simulates the behavior of callToolStream returning a stream that ends with a result.
 */
function createMockCallToolStream(result: unknown) {
  return async function* () {
    yield { type: 'result', result }
  }
}

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn(function () {
    return { start: vi.fn(), send: vi.fn(), close: vi.fn() }
  }),
}))

vi.mock('@modelcontextprotocol/sdk/client/auth-extensions.js', () => ({
  ClientCredentialsProvider: vi.fn(function () {
    return { redirectUrl: undefined, clientMetadata: { client_id: 'test' } }
  }),
}))

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(function () {
    return {
      connect: vi.fn(),
      close: vi.fn(),
      listTools: vi.fn(),
      callTool: vi.fn(),
      setRequestHandler: vi.fn(),
      setNotificationHandler: vi.fn(),
      getServerCapabilities: vi.fn(),
      getServerVersion: vi.fn(),
      getInstructions: vi.fn(),
      experimental: {
        tasks: {
          callToolStream: vi.fn(),
        },
      },
    }
  }),
}))

vi.mock('../../tools/tool.js', () => ({
  Tool: class {},
  createErrorResult: (err: unknown, toolUseId: string) => ({
    type: 'toolResultBlock',
    status: 'error',
    toolUseId,
    content: [{ type: 'textBlock', text: err instanceof Error ? err.message : String(err) }],
  }),
}))

/**
 * Executes a tool stream to completion and returns the final result.
 */
async function runTool<T>(gen: AsyncGenerator<unknown, T, unknown>): Promise<T> {
  let result = await gen.next()
  while (!result.done) {
    result = await gen.next()
  }
  return result.value as T
}

/**
 * Mock an active span with a valid trace ID via trace.getSpan,
 * and stub propagation.inject to populate the carrier with a traceparent.
 */
function mockActiveSpan(traceId: string = '1234567890abcdef1234567890abcdef', traceFlags = TraceFlags.SAMPLED): void {
  const mockSpan = {
    spanContext: () =>
      ({
        traceId,
        spanId: '1234567890abcdef',
        traceFlags,
      }) as SpanContext,
  }
  vi.spyOn(trace, 'getSpan').mockReturnValue(mockSpan as unknown as ReturnType<typeof trace.getSpan>)
  vi.spyOn(propagation, 'inject').mockImplementation((_context, carrier) => {
    if (carrier && typeof carrier === 'object') {
      ;(carrier as Record<string, string>).traceparent = `00-${traceId}-1234567890abcdef-01`
    }
  })
}

const mockTransport = {
  connect: vi.fn(),
  close: vi.fn(),
  send: vi.fn(),
} as unknown as Transport

describe('MCP Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  function createElicitationClient(callback: ElicitationCallback) {
    const resultsLengthBefore = vi.mocked(Client).mock.results.length
    const elicitClient = new McpClient({
      applicationName: 'TestApp',
      transport: mockTransport,
      elicitationCallback: callback,
    })
    const elicitSdkClientMock = vi.mocked(Client).mock.results[resultsLengthBefore]!.value
    return { elicitClient, elicitSdkClientMock }
  }

  async function connectAndGetElicitationHandler(callback: ElicitationCallback) {
    const { elicitClient, elicitSdkClientMock } = createElicitationClient(callback)
    await elicitClient.connect()
    const handler = elicitSdkClientMock.setRequestHandler.mock.calls[0]![1]
    return { handler, elicitSdkClientMock }
  }

  describe('McpClient', () => {
    let client: McpClient
    let sdkClientMock: {
      connect: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      listTools: ReturnType<typeof vi.fn>
      callTool: ReturnType<typeof vi.fn>
      setRequestHandler: ReturnType<typeof vi.fn>
      setNotificationHandler: ReturnType<typeof vi.fn>
      getServerCapabilities: ReturnType<typeof vi.fn>
      getServerVersion: ReturnType<typeof vi.fn>
      getInstructions: ReturnType<typeof vi.fn>
      experimental: { tasks: { callToolStream: ReturnType<typeof vi.fn> } }
    }

    beforeEach(() => {
      client = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
      })
      sdkClientMock = vi.mocked(Client).mock.results[0]!.value
    })

    it('initializes SDK client with correct configuration', () => {
      expect(Client).toHaveBeenCalledWith(
        { name: 'TestApp', version: '0.0.1' },
        expect.objectContaining({
          listChanged: expect.objectContaining({
            tools: expect.objectContaining({ autoRefresh: false, debounceMs: 300 }),
          }),
        })
      )
    })

    it('injects trace context into tool arguments when active span exists', async () => {
      mockActiveSpan()
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client })
      sdkClientMock.callTool.mockResolvedValue({ content: [] })

      await client.callTool(tool, { op: 'add' })

      const callArgs = sdkClientMock.callTool.mock.calls[0]![0]
      expect(callArgs.arguments).toStrictEqual({
        op: 'add',
        _meta: { traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01' },
      })
    })

    it('merges trace context with existing _meta field', async () => {
      mockActiveSpan()
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client })
      sdkClientMock.callTool.mockResolvedValue({ content: [] })

      await client.callTool(tool, { op: 'add', _meta: { progressToken: 'tok-1' } })

      const callArgs = sdkClientMock.callTool.mock.calls[0]![0]
      expect(callArgs.arguments).toStrictEqual({
        op: 'add',
        _meta: {
          progressToken: 'tok-1',
          traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01',
        },
      })
    })

    it('passes args unchanged when no active span exists', async () => {
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client })
      sdkClientMock.callTool.mockResolvedValue({ content: [] })

      await client.callTool(tool, { op: 'add' })

      const callArgs = sdkClientMock.callTool.mock.calls[0]![0]
      expect(callArgs.arguments).toStrictEqual({ op: 'add' })
    })

    it('passes args unchanged when span has empty trace ID', async () => {
      mockActiveSpan('', TraceFlags.NONE)
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client })
      sdkClientMock.callTool.mockResolvedValue({ content: [] })

      await client.callTool(tool, { op: 'add' })

      const callArgs = sdkClientMock.callTool.mock.calls[0]![0]
      expect(callArgs.arguments).toStrictEqual({ op: 'add' })
    })

    it('passes args unchanged when context injection fails', async () => {
      vi.spyOn(context, 'active').mockImplementation(() => {
        throw new Error('Context error')
      })
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client })
      sdkClientMock.callTool.mockResolvedValue({ content: [] })

      await client.callTool(tool, { op: 'add' })

      const callArgs = sdkClientMock.callTool.mock.calls[0]![0]
      expect(callArgs.arguments).toStrictEqual({ op: 'add' })
    })

    it('skips trace context injection when disableMcpInstrumentation is true', async () => {
      mockActiveSpan()
      const noInstrClient = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        disableMcpInstrumentation: true,
      })
      const noInstrSdkMock = vi.mocked(Client).mock.results.at(-1)!.value
      noInstrSdkMock.callTool.mockResolvedValue({ content: [] })

      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client: noInstrClient })

      await noInstrClient.callTool(tool, { op: 'add' })

      const callArgs = noInstrSdkMock.callTool.mock.calls[0]![0]
      expect(callArgs.arguments).toStrictEqual({ op: 'add' })
    })

    it('manages connection state lazily', async () => {
      await client.connect()
      expect(sdkClientMock.connect).toHaveBeenCalledTimes(1)

      await client.connect()
      expect(sdkClientMock.connect).toHaveBeenCalledTimes(1)
    })

    it('supports forced reconnection', async () => {
      await client.connect()
      await client.connect(true)

      expect(sdkClientMock.close).toHaveBeenCalled()
      expect(sdkClientMock.connect).toHaveBeenCalledTimes(2)
    })

    it('converts SDK tool specs to McpTool instances', async () => {
      const outputSchema = {
        type: 'object' as const,
        properties: { forecast: { type: 'string' as const } },
        required: ['forecast'],
      }
      sdkClientMock.listTools.mockResolvedValue({
        tools: [{ name: 'weather', description: 'Get weather', inputSchema: {}, outputSchema }],
      })

      const tools = await client.listTools()

      expect(sdkClientMock.connect).toHaveBeenCalled()
      expect(tools).toHaveLength(1)
      expect(tools[0]).toBeInstanceOf(McpTool)
      expect(tools[0]!.toolSpec).toEqual({
        name: 'weather',
        description: 'Get weather',
        inputSchema: {},
        outputSchema,
      })
    })

    it('paginates through all pages of tools', async () => {
      sdkClientMock.listTools
        .mockResolvedValueOnce({
          tools: [{ name: 'tool_a', description: 'A', inputSchema: {} }],
          nextCursor: 'page2',
        })
        .mockResolvedValueOnce({
          tools: [{ name: 'tool_b', description: 'B', inputSchema: {} }],
          nextCursor: 'page3',
        })
        .mockResolvedValueOnce({
          tools: [{ name: 'tool_c', description: 'C', inputSchema: {} }],
        })

      const tools = await client.listTools()

      expect(tools).toHaveLength(3)
      expect(tools.map((t) => t.name)).toEqual(['tool_a', 'tool_b', 'tool_c'])
      expect(sdkClientMock.listTools).toHaveBeenCalledTimes(3)
      expect(sdkClientMock.listTools).toHaveBeenNthCalledWith(1, undefined)
      expect(sdkClientMock.listTools).toHaveBeenNthCalledWith(2, { cursor: 'page2' })
      expect(sdkClientMock.listTools).toHaveBeenNthCalledWith(3, { cursor: 'page3' })
    })

    it('matches strings and regexes against the server-side name and passes the renamed tool to callbacks', async () => {
      const callback = vi.fn((tool: McpTool) => tool.name === 'server_callback_tool')
      const statefulPattern = /regex_/g
      statefulPattern.lastIndex = 4
      const filteredClient = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        prefix: 'server',
        toolFilters: {
          allowed: ['exact', statefulPattern, callback],
          rejected: ['regex_rejected'],
        },
      })
      const filteredSdkClient = vi.mocked(Client).mock.results.at(-1)!.value
      filteredSdkClient.listTools.mockResolvedValue({
        tools: [
          { name: 'exact', inputSchema: {} },
          { name: 'exact_extra', inputSchema: {} },
          { name: 'regex_allowed', inputSchema: {} },
          { name: 'xregex_unanchored', inputSchema: {} },
          { name: 'regex_rejected', inputSchema: {} },
          { name: 'callback_tool', inputSchema: {} },
        ],
      })

      const tools = await filteredClient.listTools()

      // 'exact' and /regex_/ matched despite every exposed name carrying the prefix, and
      // 'xregex_unanchored' was dropped because the regex only matches from the start.
      expect(tools.map((tool) => tool.name)).toEqual(['server_exact', 'server_regex_allowed', 'server_callback_tool'])
      expect(callback.mock.calls.map(([tool]) => tool.name)).toEqual([
        'server_exact_extra',
        'server_xregex_unanchored',
        'server_callback_tool',
      ])
      expect(statefulPattern.lastIndex).toBe(4)
    })

    it('applies allowed before rejected with rejected winning and distinguishes missing from empty allowed', async () => {
      sdkClientMock.listTools.mockResolvedValue({
        tools: [
          { name: 'one', inputSchema: {} },
          { name: 'two', inputSchema: {} },
        ],
      })

      expect((await client.listTools({ toolFilters: { rejected: ['two'] } })).map((tool) => tool.name)).toEqual(['one'])
      expect((await client.listTools({ toolFilters: { allowed: [] } })).map((tool) => tool.name)).toEqual([])
      expect(
        (await client.listTools({ toolFilters: { allowed: ['one'], rejected: ['one'] } })).map((tool) => tool.name)
      ).toEqual([])
    })

    it('inherits constructor defaults while explicit empty prefix and filters disable them', async () => {
      const defaultedClient = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        prefix: 'default',
        toolFilters: { allowed: ['one'] },
      })
      const defaultedSdkClient = vi.mocked(Client).mock.results.at(-1)!.value
      defaultedSdkClient.listTools.mockResolvedValue({
        tools: [
          { name: 'one', inputSchema: {} },
          { name: 'two', inputSchema: {} },
        ],
      })

      const defaultedTools = await defaultedClient.listTools()
      expect(defaultedTools.map((tool) => tool.name)).toEqual(['default_one'])
      expect(defaultedTools[0]!.toolSpec).toEqual({
        name: 'default_one',
        description: 'Tool which performs one',
        inputSchema: {},
      })
      expect((await defaultedClient.listTools({ prefix: '', toolFilters: {} })).map((tool) => tool.name)).toEqual([
        'one',
        'two',
      ])
      expect(
        (await defaultedClient.listTools({ prefix: 'override', toolFilters: { allowed: ['two'] } })).map(
          (tool) => tool.name
        )
      ).toEqual(['override_two'])
    })

    it('filters and prefixes every page and invokes prefixed tools by the server-side name', async () => {
      const prefixedClient = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        prefix: 'server',
        toolFilters: { allowed: [/keep_/] },
      })
      const prefixedSdkClient = vi.mocked(Client).mock.results.at(-1)!.value
      prefixedSdkClient.listTools
        .mockResolvedValueOnce({
          tools: [
            { name: 'keep_one', inputSchema: {} },
            { name: 'drop_one', inputSchema: {} },
          ],
          nextCursor: 'page2',
        })
        .mockResolvedValueOnce({ tools: [{ name: 'keep_two', inputSchema: {} }] })
      prefixedSdkClient.callTool.mockResolvedValue({ content: [] })

      const tools = await prefixedClient.listTools()
      await prefixedClient.callTool(tools[1]!, { value: 1 })

      expect(tools.map((tool) => tool.name)).toEqual(['server_keep_one', 'server_keep_two'])
      expect(prefixedSdkClient.callTool).toHaveBeenCalledWith(
        { name: 'keep_two', arguments: { value: 1 } },
        undefined,
        undefined
      )
    })

    it('uses the server-side name for task-based invocation of a prefixed tool', async () => {
      const taskClient = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        prefix: 'server',
        tasksConfig: {},
      })
      const taskSdkClient = vi.mocked(Client).mock.results.at(-1)!.value
      taskSdkClient.listTools.mockResolvedValue({ tools: [{ name: 'long_task', inputSchema: {} }] })
      taskSdkClient.experimental.tasks.callToolStream.mockReturnValue(createMockCallToolStream({ content: [] })())

      const [tool] = await taskClient.listTools()
      await taskClient.callTool(tool!, {})

      expect(taskSdkClient.experimental.tasks.callToolStream).toHaveBeenCalledWith(
        { name: 'long_task', arguments: {} },
        undefined,
        expect.any(Object)
      )
    })

    it('surfaces tool annotations in the tool spec', async () => {
      const annotations = { title: 'Get Weather', readOnlyHint: true }
      sdkClientMock.listTools.mockResolvedValue({
        tools: [{ name: 'weather', description: 'Get weather', inputSchema: {}, annotations }],
      })

      const tools = await client.listTools()

      expect(tools[0]!.toolSpec).toEqual({
        name: 'weather',
        description: 'Get weather',
        inputSchema: {},
        annotations,
      })
    })

    it('omits annotations from the tool spec when the server provides none', async () => {
      sdkClientMock.listTools.mockResolvedValue({
        tools: [{ name: 'weather', description: 'Get weather', inputSchema: {} }],
      })

      const tools = await client.listTools()

      expect(tools[0]!.toolSpec).not.toHaveProperty('annotations')
    })

    it('omits annotations from the tool spec when the server provides an empty annotations object', async () => {
      sdkClientMock.listTools.mockResolvedValue({
        tools: [{ name: 'weather', description: 'Get weather', inputSchema: {}, annotations: {} }],
      })

      const tools = await client.listTools()

      expect(tools[0]!.toolSpec).not.toHaveProperty('annotations')
    })

    it('generates description fallback when description is missing', async () => {
      sdkClientMock.listTools.mockResolvedValue({
        tools: [{ name: 'my_tool', inputSchema: {} }],
      })

      const tools = await client.listTools()

      expect(tools[0]!.description).toBe('Tool which performs my_tool')
    })

    it('generates description fallback when description is empty string', async () => {
      sdkClientMock.listTools.mockResolvedValue({
        tools: [{ name: 'my_tool', description: '', inputSchema: {} }],
      })

      const tools = await client.listTools()

      expect(tools[0]!.description).toBe('Tool which performs my_tool')
    })

    it('uses callTool when tasksConfig is undefined (default)', async () => {
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client })
      sdkClientMock.callTool.mockResolvedValue({ content: [] })

      await client.callTool(tool, { op: 'add' })

      expect(sdkClientMock.connect).toHaveBeenCalled()
      expect(sdkClientMock.callTool).toHaveBeenCalledWith(
        { name: 'calc', arguments: { op: 'add' } },
        undefined,
        undefined
      )
      expect(sdkClientMock.experimental.tasks.callToolStream).not.toHaveBeenCalled()
    })

    it('forwards abort signal to SDK callTool', async () => {
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client })
      sdkClientMock.callTool.mockResolvedValue({ content: [] })
      const controller = new AbortController()

      await client.callTool(tool, { op: 'add' }, { signal: controller.signal })

      expect(sdkClientMock.callTool).toHaveBeenCalledWith({ name: 'calc', arguments: { op: 'add' } }, undefined, {
        signal: controller.signal,
      })
    })

    it('forwards the client progress callback to direct tool calls', async () => {
      const onProgress = vi.fn()
      const progressClient = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        onProgress,
      })
      const progressSdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client: progressClient })
      progressSdkClientMock.callTool.mockResolvedValue({ content: [] })

      await progressClient.callTool(tool, { op: 'add' })

      expect(progressSdkClientMock.callTool).toHaveBeenCalledWith(
        { name: 'calc', arguments: { op: 'add' } },
        undefined,
        { onprogress: expect.any(Function), resetTimeoutOnProgress: true }
      )

      const requestOptions = progressSdkClientMock.callTool.mock.calls[0]![2] as RequestOptions
      requestOptions.onprogress?.({ progress: 1, total: 2, message: 'working' })
      await vi.waitFor(() => {
        expect(onProgress).toHaveBeenCalledWith({ progress: 1, total: 2, message: 'working' })
      })
    })

    it('uses a per-call progress callback instead of the client callback', async () => {
      const defaultOnProgress = vi.fn()
      const callOnProgress = vi.fn()
      const progressClient = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        onProgress: defaultOnProgress,
      })
      const progressSdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client: progressClient })
      progressSdkClientMock.callTool.mockResolvedValue({ content: [] })

      await progressClient.callTool(tool, { op: 'add' }, { onProgress: callOnProgress })

      expect(progressSdkClientMock.callTool).toHaveBeenCalledWith(
        { name: 'calc', arguments: { op: 'add' } },
        undefined,
        { onprogress: expect.any(Function), resetTimeoutOnProgress: true }
      )

      const requestOptions = progressSdkClientMock.callTool.mock.calls[0]![2] as RequestOptions
      requestOptions.onprogress?.({ progress: 1 })
      await vi.waitFor(() => {
        expect(callOnProgress).toHaveBeenCalledWith({ progress: 1 })
        expect(defaultOnProgress).not.toHaveBeenCalled()
      })
    })

    it('forwards cancellation and bounded timeout options with progress', async () => {
      const onProgress = vi.fn()
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client })
      sdkClientMock.callTool.mockResolvedValue({ content: [] })
      const controller = new AbortController()

      await client.callTool(
        tool,
        { op: 'add' },
        {
          signal: controller.signal,
          onProgress,
          timeout: 30000,
          maxTotalTimeout: 120000,
        }
      )

      expect(sdkClientMock.callTool).toHaveBeenCalledWith({ name: 'calc', arguments: { op: 'add' } }, undefined, {
        signal: controller.signal,
        timeout: 30000,
        onprogress: expect.any(Function),
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 120000,
      })
    })

    it('logs progress callback failures without rejecting the tool call', async () => {
      const callbackError = new Error('progress sink failed')
      const onProgress = vi.fn(async () => {
        throw callbackError
      })
      const progressClient = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        onProgress,
      })
      const progressSdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client: progressClient })
      progressSdkClientMock.callTool.mockResolvedValue({ content: [] })
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

      await progressClient.callTool(tool, { op: 'add' })
      const requestOptions = progressSdkClientMock.callTool.mock.calls[0]![2] as RequestOptions
      requestOptions.onprogress?.({ progress: 1 })

      await vi.waitFor(() => {
        expect(warnSpy).toHaveBeenCalledWith(
          'tool=<calc>, error=<Error: progress sink failed> | progress callback failed'
        )
      })
    })

    it('forwards abort signal to callToolStream when tasksConfig is provided', async () => {
      const resultsLengthBefore = vi.mocked(Client).mock.results.length
      const taskClient = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        tasksConfig: {},
      })
      const taskSdkClientMock = vi.mocked(Client).mock.results[resultsLengthBefore]!.value
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client: taskClient })
      taskSdkClientMock.experimental.tasks.callToolStream.mockReturnValue(createMockCallToolStream({ content: [] })())
      const controller = new AbortController()

      await taskClient.callTool(tool, { op: 'add' }, { signal: controller.signal })

      expect(taskSdkClientMock.experimental.tasks.callToolStream).toHaveBeenCalledWith(
        { name: 'calc', arguments: { op: 'add' } },
        undefined,
        { timeout: 60000, maxTotalTimeout: 300000, resetTimeoutOnProgress: true, signal: controller.signal }
      )
    })

    it('ignores progress callbacks for task-augmented tool calls', async () => {
      const resultsLengthBefore = vi.mocked(Client).mock.results.length
      const taskClient = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        tasksConfig: {},
        onProgress: vi.fn(),
      })
      const taskSdkClientMock = vi.mocked(Client).mock.results[resultsLengthBefore]!.value
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client: taskClient })
      taskSdkClientMock.experimental.tasks.callToolStream.mockReturnValue(createMockCallToolStream({ content: [] })())
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined)

      await taskClient.callTool(tool, { op: 'add' })

      expect(taskSdkClientMock.experimental.tasks.callToolStream).toHaveBeenCalledWith(
        { name: 'calc', arguments: { op: 'add' } },
        undefined,
        { timeout: 60000, maxTotalTimeout: 300000, resetTimeoutOnProgress: true }
      )
      expect(warnSpy).toHaveBeenCalledWith(
        'tool=<calc> | progress callbacks are ignored when task-augmented execution is enabled'
      )
    })

    it('uses callToolStream when tasksConfig is provided (empty object)', async () => {
      const resultsLengthBefore = vi.mocked(Client).mock.results.length
      const taskClient = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        tasksConfig: {},
      })
      const taskSdkClientMock = vi.mocked(Client).mock.results[resultsLengthBefore]!.value
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client: taskClient })
      taskSdkClientMock.experimental.tasks.callToolStream.mockReturnValue(createMockCallToolStream({ content: [] })())

      await taskClient.callTool(tool, { op: 'add' })

      expect(taskSdkClientMock.connect).toHaveBeenCalled()
      expect(taskSdkClientMock.experimental.tasks.callToolStream).toHaveBeenCalledWith(
        { name: 'calc', arguments: { op: 'add' } },
        undefined,
        { timeout: 60000, maxTotalTimeout: 300000, resetTimeoutOnProgress: true }
      )
      expect(taskSdkClientMock.callTool).not.toHaveBeenCalled()
    })

    it('passes custom TTL and pollTimeout to callToolStream', async () => {
      const resultsLengthBefore = vi.mocked(Client).mock.results.length
      const taskClient = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        tasksConfig: { ttl: 30000, pollTimeout: 120000 },
      })
      const taskSdkClientMock = vi.mocked(Client).mock.results[resultsLengthBefore]!.value
      const tool = new McpTool({ name: 'calc', description: '', inputSchema: {}, client: taskClient })
      taskSdkClientMock.experimental.tasks.callToolStream.mockReturnValue(createMockCallToolStream({ content: [] })())

      await taskClient.callTool(tool, { op: 'add' })

      expect(taskSdkClientMock.experimental.tasks.callToolStream).toHaveBeenCalledWith(
        { name: 'calc', arguments: { op: 'add' } },
        undefined,
        { timeout: 30000, maxTotalTimeout: 120000, resetTimeoutOnProgress: true }
      )
    })

    it('validates tool arguments', async () => {
      const tool = new McpTool({ name: 't', description: '', inputSchema: {}, client })
      await expect(client.callTool(tool, ['invalid-array'])).rejects.toThrow(/JSON Object/)
    })

    it('cleans up resources', async () => {
      await client.disconnect()
      expect(sdkClientMock.close).toHaveBeenCalled()
      expect(mockTransport.close).toHaveBeenCalled()
    })

    it('supports Symbol.asyncDispose for await using pattern', async () => {
      await client[Symbol.asyncDispose]()
      expect(sdkClientMock.close).toHaveBeenCalled()
      expect(mockTransport.close).toHaveBeenCalled()
    })

    it('registers elicitation handler before connecting when callback is provided', async () => {
      const resultsLengthBefore = vi.mocked(Client).mock.results.length
      const callback: ElicitationCallback = vi.fn()
      const elicitClient = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        elicitationCallback: callback,
      })
      const elicitSdkClientMock = vi.mocked(Client).mock.results[resultsLengthBefore]!.value

      await elicitClient.connect()

      expect(elicitSdkClientMock.setRequestHandler).toHaveBeenCalledWith(ElicitRequestSchema, expect.any(Function))
      const setHandlerOrder = elicitSdkClientMock.setRequestHandler.mock.invocationCallOrder[0]!
      const connectOrder = elicitSdkClientMock.connect.mock.invocationCallOrder[0]!
      expect(setHandlerOrder).toBeLessThan(connectOrder)
    })

    it('does not register elicitation handler when no callback is provided', async () => {
      await client.connect()

      expect(sdkClientMock.setRequestHandler).not.toHaveBeenCalled()
    })

    it('passes elicitation capabilities to Client when callback is provided', () => {
      const callback: ElicitationCallback = vi.fn()
      new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        elicitationCallback: callback,
      })

      const lastCall = vi.mocked(Client).mock.calls.at(-1)!
      expect(lastCall[1]).toEqual(expect.objectContaining({ capabilities: { elicitation: { form: {}, url: {} } } }))
    })

    it('elicitation handler returns accepted result with content', async () => {
      const callbackResult = { action: 'accept' as const, content: { username: 'alice' } }
      const callback: ElicitationCallback = vi.fn().mockResolvedValue(callbackResult)
      const { handler } = await connectAndGetElicitationHandler(callback)
      const request = {
        method: 'elicitation/create',
        params: { message: 'Enter username', requestedSchema: { type: 'object' } },
      }
      const extra = { signal: new AbortController().signal }

      const result = await handler(request, extra)

      expect(callback).toHaveBeenCalledWith(extra, request.params)
      expect(result).toEqual({ action: 'accept', content: { username: 'alice' } })
    })

    it.each([{ action: 'decline' as const }, { action: 'cancel' as const }])(
      'elicitation handler returns $action result',
      async (callbackResult) => {
        const callback: ElicitationCallback = vi.fn().mockResolvedValue(callbackResult)
        const { handler } = await connectAndGetElicitationHandler(callback)
        const request = {
          method: 'elicitation/create',
          params: { message: 'Enter username', requestedSchema: { type: 'object' } },
        }
        const extra = { signal: new AbortController().signal }

        const result = await handler(request, extra)

        expect(callback).toHaveBeenCalledWith(extra, request.params)
        expect(result).toEqual({ action: callbackResult.action })
      }
    )

    it('elicitation handler works for URL mode params', async () => {
      const callbackResult = { action: 'accept' as const }
      const callback: ElicitationCallback = vi.fn().mockResolvedValue(callbackResult)
      const { handler } = await connectAndGetElicitationHandler(callback)
      const request = {
        method: 'elicitation/create',
        params: {
          mode: 'url',
          message: 'Please authenticate',
          url: 'https://example.com/auth',
          elicitationId: 'elicit-123',
        },
      }
      const extra = { signal: new AbortController().signal }

      const result = await handler(request, extra)

      expect(callback).toHaveBeenCalledWith(extra, request.params)
      expect(result).toEqual({ action: 'accept' })
    })

    it('elicitation callback errors propagate', async () => {
      const callback: ElicitationCallback = vi.fn().mockRejectedValue(new Error('User cancelled'))
      const { handler } = await connectAndGetElicitationHandler(callback)
      const request = {
        method: 'elicitation/create',
        params: { message: 'Confirm?' },
      }
      const extra = { signal: new AbortController().signal }

      await expect(handler(request, extra)).rejects.toThrow('User cancelled')
    })
  })

  describe('tools list changed', () => {
    let client: McpClient
    let sdkClientMock: {
      connect: ReturnType<typeof vi.fn>
      close: ReturnType<typeof vi.fn>
      listTools: ReturnType<typeof vi.fn>
      callTool: ReturnType<typeof vi.fn>
      setRequestHandler: ReturnType<typeof vi.fn>
      setNotificationHandler: ReturnType<typeof vi.fn>
      getServerCapabilities: ReturnType<typeof vi.fn>
      getServerVersion: ReturnType<typeof vi.fn>
      getInstructions: ReturnType<typeof vi.fn>
      experimental: { tasks: { callToolStream: ReturnType<typeof vi.fn> } }
    }

    beforeEach(() => {
      client = new McpClient({ applicationName: 'TestApp', transport: mockTransport })
      sdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
      sdkClientMock.connect.mockResolvedValue(undefined)
    })

    function triggerToolsChanged(): void {
      const ctorCall = vi.mocked(Client).mock.calls.at(-1)!
      ctorCall[1]!.listChanged!.tools!.onChanged(null, null)
    }

    it('calls onToolsChanged with old names and new tools when list changes', async () => {
      sdkClientMock.listTools.mockResolvedValue({
        tools: [{ name: 'tool_a', description: 'A', inputSchema: {} }],
      })
      await client.listTools()

      const onToolsChanged = vi.fn()
      client.onToolsChanged = onToolsChanged

      sdkClientMock.listTools.mockResolvedValue({
        tools: [
          { name: 'tool_a', description: 'A', inputSchema: {} },
          { name: 'tool_b', description: 'B', inputSchema: {} },
        ],
      })

      triggerToolsChanged()
      await vi.waitFor(() => expect(onToolsChanged).toHaveBeenCalled())

      expect(onToolsChanged).toHaveBeenCalledWith(['tool_a'], expect.any(Array))
      const newTools = onToolsChanged.mock.calls[0]![1] as McpTool[]
      expect(newTools.map((t) => t.name)).toEqual(['tool_a', 'tool_b'])
    })

    it('updates registered tool names after each listTools call', async () => {
      sdkClientMock.listTools.mockResolvedValue({
        tools: [
          { name: 'x', description: 'X', inputSchema: {} },
          { name: 'y', description: 'Y', inputSchema: {} },
        ],
      })
      await client.listTools()

      const onToolsChanged = vi.fn()
      client.onToolsChanged = onToolsChanged

      sdkClientMock.listTools.mockResolvedValue({
        tools: [{ name: 'z', description: 'Z', inputSchema: {} }],
      })

      triggerToolsChanged()
      await vi.waitFor(() => expect(onToolsChanged).toHaveBeenCalled())

      expect(onToolsChanged).toHaveBeenCalledWith(['x', 'y'], expect.any(Array))
      const newTools = onToolsChanged.mock.calls[0]![1] as McpTool[]
      expect(newTools.map((t) => t.name)).toEqual(['z'])
    })

    it('keeps default registered names after an overridden listing', async () => {
      client = new McpClient({ applicationName: 'TestApp', transport: mockTransport, prefix: 'default' })
      sdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
      sdkClientMock.connect.mockResolvedValue(undefined)
      sdkClientMock.listTools.mockResolvedValue({
        tools: [{ name: 'tool_a', description: 'A', inputSchema: {} }],
      })
      await client.listTools()
      await client.listTools({ prefix: 'temporary' })
      const onToolsChanged = vi.fn()
      client.onToolsChanged = onToolsChanged

      triggerToolsChanged()
      await vi.waitFor(() => expect(onToolsChanged).toHaveBeenCalled())

      expect(onToolsChanged).toHaveBeenCalledWith(['default_tool_a'], expect.any(Array))
    })

    it('reapplies constructor filters and prefix when refreshing', async () => {
      client = new McpClient({
        applicationName: 'TestApp',
        transport: mockTransport,
        prefix: 'server',
        toolFilters: { allowed: ['tool_a'] },
      })
      sdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
      sdkClientMock.connect.mockResolvedValue(undefined)
      sdkClientMock.listTools.mockResolvedValue({
        tools: [
          { name: 'tool_a', inputSchema: {} },
          { name: 'tool_b', inputSchema: {} },
        ],
      })
      await client.listTools()
      const onToolsChanged = vi.fn()
      client.onToolsChanged = onToolsChanged

      triggerToolsChanged()
      await vi.waitFor(() => expect(onToolsChanged).toHaveBeenCalled())

      expect(onToolsChanged).toHaveBeenCalledWith(['server_tool_a'], expect.any(Array))
      const newTools = onToolsChanged.mock.calls[0]![1] as McpTool[]
      expect(newTools.map((tool) => tool.name)).toEqual(['server_tool_a'])
    })

    it('does not throw when onToolsChanged is not set', async () => {
      sdkClientMock.listTools.mockResolvedValue({
        tools: [{ name: 'tool_a', description: 'A', inputSchema: {} }],
      })
      await client.listTools()

      sdkClientMock.listTools.mockResolvedValue({
        tools: [{ name: 'tool_b', description: 'B', inputSchema: {} }],
      })

      triggerToolsChanged()
      await new Promise((r) => setTimeout(r, 0))
    })

    it('logs warning and preserves registry when listTools fails during refresh', async () => {
      sdkClientMock.listTools.mockResolvedValue({
        tools: [{ name: 'tool_a', description: 'A', inputSchema: {} }],
      })
      await client.listTools()

      const onToolsChanged = vi.fn()
      client.onToolsChanged = onToolsChanged

      sdkClientMock.listTools.mockRejectedValue(new Error('server disconnected'))
      const warnSpy = vi.spyOn(logger, 'warn')

      triggerToolsChanged()
      await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled())

      expect(onToolsChanged).not.toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('failed to refresh tools'))
    })

    it('coalesces notifications received during an in-flight refresh into one extra refresh', async () => {
      sdkClientMock.listTools.mockResolvedValue({
        tools: [{ name: 'tool_a', description: 'A', inputSchema: {} }],
      })
      await client.listTools()

      const onToolsChanged = vi.fn()
      client.onToolsChanged = onToolsChanged

      let resolveListTools: (value: unknown) => void
      sdkClientMock.listTools.mockReturnValue(new Promise((r) => (resolveListTools = r)))

      triggerToolsChanged()
      triggerToolsChanged()
      triggerToolsChanged()

      resolveListTools!({ tools: [{ name: 'tool_b', description: 'B', inputSchema: {} }] })
      await vi.waitFor(() => expect(onToolsChanged).toHaveBeenCalledTimes(2))

      expect(sdkClientMock.listTools).toHaveBeenCalledTimes(3)
    })
  })

  describe('McpTool', () => {
    const mockClientWrapper = { callTool: vi.fn() } as unknown as McpClient
    const tool = new McpTool({
      name: 'weather',
      description: 'Get weather',
      inputSchema: {},
      client: mockClientWrapper,
    })

    const toolContext: ToolContext = {
      toolUse: { toolUseId: 'id-123', name: 'weather', input: { city: 'NYC' } },
      agent: { cancelSignal: new AbortController().signal } as LocalAgent,
      invocationState: {},
      cancelSignal: new AbortController().signal,
      interrupt: () => {
        throw new Error('interrupt not available in mock context')
      },
    }

    it('forwards the tool execution cancelSignal to callTool', async () => {
      vi.mocked(mockClientWrapper.callTool).mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      })

      await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(mockClientWrapper.callTool).toHaveBeenCalledWith(
        tool,
        { city: 'NYC' },
        {
          signal: toolContext.cancelSignal,
        }
      )
    })

    it('returns text results on success', async () => {
      vi.mocked(mockClientWrapper.callTool).mockResolvedValue({
        content: [{ type: 'text', text: 'Sunny' }],
      })

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result).toBeDefined()
      expect(result.status).toBe('success')
      expect((result.content[0] as TextBlock).text).toBe('Sunny')
    })

    it('returns structured data results on success', async () => {
      const data = { temperature: 72 }
      vi.mocked(mockClientWrapper.callTool).mockResolvedValue({
        content: [{ type: 'data', value: data }],
      })

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))
      const content = result.content[0] as JsonBlock

      expect(content).toBeInstanceOf(JsonBlock)
      expect(content.json).toEqual(expect.objectContaining({ value: data }))
    })

    it('provides default message for empty output', async () => {
      vi.mocked(mockClientWrapper.callTool).mockResolvedValue({ content: [] })

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect((result.content[0] as TextBlock).text).toContain('completed successfully')
    })

    it('handles protocol-level errors', async () => {
      vi.mocked(mockClientWrapper.callTool).mockResolvedValue({
        isError: true,
        content: [{ type: 'text', text: 'Service Unavailable' }],
      })

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toBe('Service Unavailable')
    })

    it('catches and wraps client exceptions', async () => {
      vi.mocked(mockClientWrapper.callTool).mockRejectedValue(new Error('Network Error'))

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toBe('Network Error')
    })

    it('validates SDK response format', async () => {
      vi.mocked(mockClientWrapper.callTool).mockResolvedValue({ content: null })

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toContain('missing content array')
    })

    it('maps MCP image content to ImageBlock', async () => {
      // "iVBOR..." is a minimal base64 PNG prefix
      const base64Data = 'iVBORw0KGgoAAAANSUhEUg=='
      vi.mocked(mockClientWrapper.callTool).mockResolvedValue({
        content: [{ type: 'image', data: base64Data, mimeType: 'image/png' }],
      })

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.status).toBe('success')
      expect(result.content).toHaveLength(1)
      const imageBlock = result.content[0] as ImageBlock
      expect(imageBlock).toBeInstanceOf(ImageBlock)
      expect(imageBlock.format).toBe('png')
      expect(imageBlock.source.type).toBe('imageSourceBytes')
    })

    it('falls back to JsonBlock for unsupported image mime type', async () => {
      vi.mocked(mockClientWrapper.callTool).mockResolvedValue({
        content: [{ type: 'image', data: 'abc123', mimeType: 'image/bmp' }],
      })

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.content[0]).toBeInstanceOf(JsonBlock)
    })

    it('falls back to JsonBlock for image content missing data', async () => {
      vi.mocked(mockClientWrapper.callTool).mockResolvedValue({
        content: [{ type: 'image', mimeType: 'image/png' }],
      })

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.content[0]).toBeInstanceOf(JsonBlock)
    })

    it('maps MCP text resource to TextBlock', async () => {
      vi.mocked(mockClientWrapper.callTool).mockResolvedValue({
        content: [
          { type: 'resource', resource: { uri: 'file:///doc.txt', text: 'hello world', mimeType: 'text/plain' } },
        ],
      })

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.status).toBe('success')
      expect((result.content[0] as TextBlock).text).toBe('hello world')
    })

    it('maps MCP blob resource with image mime type to ImageBlock', async () => {
      const base64Data = 'iVBORw0KGgoAAAANSUhEUg=='
      vi.mocked(mockClientWrapper.callTool).mockResolvedValue({
        content: [{ type: 'resource', resource: { uri: 'file:///img.png', blob: base64Data, mimeType: 'image/jpeg' } }],
      })

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.content[0]).toBeInstanceOf(ImageBlock)
      expect((result.content[0] as ImageBlock).format).toBe('jpeg')
    })

    it('falls back to JsonBlock for blob resource with non-image mime type', async () => {
      vi.mocked(mockClientWrapper.callTool).mockResolvedValue({
        content: [
          { type: 'resource', resource: { uri: 'file:///doc.pdf', blob: 'abc123', mimeType: 'application/pdf' } },
        ],
      })

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.content[0]).toBeInstanceOf(JsonBlock)
    })

    it('falls back to JsonBlock for resource with neither text nor blob', async () => {
      vi.mocked(mockClientWrapper.callTool).mockResolvedValue({
        content: [{ type: 'resource', resource: { uri: 'file:///unknown' } }],
      })

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.content[0]).toBeInstanceOf(JsonBlock)
    })

    it('handles mixed content types in a single result', async () => {
      const base64Data = 'iVBORw0KGgoAAAANSUhEUg=='
      vi.mocked(mockClientWrapper.callTool).mockResolvedValue({
        content: [
          { type: 'text', text: 'Here is the image:' },
          { type: 'image', data: base64Data, mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'file:///notes.txt', text: 'Some notes' } },
        ],
      })

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.content).toHaveLength(3)
      expect((result.content[0] as TextBlock).text).toBe('Here is the image:')
      expect(result.content[1]).toBeInstanceOf(ImageBlock)
      expect((result.content[2] as TextBlock).text).toBe('Some notes')
    })

    it('surfaces elicitation data for McpError with code -32042', async () => {
      const elicitations = [
        {
          mode: 'url',
          message: 'Please authorize with GitHub',
          elicitationId: 'e-123',
          url: 'https://github.com/login/oauth/authorize?client_id=abc',
        },
      ]
      const mcpError = new McpError(ErrorCode.UrlElicitationRequired, 'Authorization required', { elicitations })
      vi.mocked(mockClientWrapper.callTool).mockRejectedValue(mcpError)

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toBe(
        `MCP Elicitation required: [${String(mcpError)}] with data ${JSON.stringify(elicitations)}`
      )
    })

    it('surfaces multiple elicitations for McpError with code -32042', async () => {
      const elicitations = [
        {
          mode: 'url',
          message: 'Authorize with GitHub',
          elicitationId: 'e-1',
          url: 'https://github.com/login/oauth/authorize',
        },
        {
          mode: 'url',
          message: 'Authorize with Google',
          elicitationId: 'e-2',
          url: 'https://accounts.google.com/o/oauth2/auth',
        },
      ]
      const mcpError = new McpError(ErrorCode.UrlElicitationRequired, 'Authorization required', { elicitations })
      vi.mocked(mockClientWrapper.callTool).mockRejectedValue(mcpError)

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toBe(
        `MCP Elicitation required: [${String(mcpError)}] with data ${JSON.stringify(elicitations)}`
      )
    })

    it('falls through to generic error for McpError -32042 with malformed data', async () => {
      const mcpError = new McpError(ErrorCode.UrlElicitationRequired, 'Authorization required', {
        unexpected: 'shape',
      })
      vi.mocked(mockClientWrapper.callTool).mockRejectedValue(mcpError)

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toBe('MCP error -32042: Authorization required')
    })

    it('surfaces elicitation data for UrlElicitationRequiredError', async () => {
      const elicitations = [
        {
          mode: 'url' as const,
          message: 'Please authorize',
          elicitationId: 'e-1',
          url: 'https://example.com/auth',
        },
      ]
      const error = new UrlElicitationRequiredError(elicitations, 'Auth required')
      vi.mocked(mockClientWrapper.callTool).mockRejectedValue(error)

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toContain('MCP Elicitation required')
      expect((result.content[0] as TextBlock).text).toContain('https://example.com/auth')
    })

    it('falls through to generic error for McpError -32042 with undefined data', async () => {
      const mcpError = new McpError(ErrorCode.UrlElicitationRequired, 'Auth required')
      vi.mocked(mockClientWrapper.callTool).mockRejectedValue(mcpError)

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toBe('MCP error -32042: Auth required')
    })

    it('falls through to generic error for McpError -32042 with non-array elicitations', async () => {
      const mcpError = new McpError(ErrorCode.UrlElicitationRequired, 'Auth required', {
        elicitations: 'not-an-array',
      })
      vi.mocked(mockClientWrapper.callTool).mockRejectedValue(mcpError)

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toBe('MCP error -32042: Auth required')
    })

    it('falls through to generic error for McpError -32042 with empty elicitations', async () => {
      const mcpError = new McpError(ErrorCode.UrlElicitationRequired, 'Auth required', {
        elicitations: [],
      })
      vi.mocked(mockClientWrapper.callTool).mockRejectedValue(mcpError)

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toBe('MCP error -32042: Auth required')
    })

    it('falls through to generic error for McpError with a different code', async () => {
      const mcpError = new McpError(ErrorCode.InvalidRequest, 'Bad request')
      vi.mocked(mockClientWrapper.callTool).mockRejectedValue(mcpError)

      const result = await runTool<ToolResultBlock>(tool.stream(toolContext))

      expect(result.status).toBe('error')
      expect((result.content[0] as TextBlock).text).toBe('MCP error -32600: Bad request')
    })
  })
})

describe('server metadata getters', () => {
  let client: McpClient
  let sdkClientMock: {
    connect: ReturnType<typeof vi.fn>
    getServerCapabilities: ReturnType<typeof vi.fn>
    getServerVersion: ReturnType<typeof vi.fn>
    getInstructions: ReturnType<typeof vi.fn>
    setNotificationHandler: ReturnType<typeof vi.fn>
    setRequestHandler: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.clearAllMocks()
    client = new McpClient({ applicationName: 'TestApp', transport: mockTransport })
    sdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns undefined for all getters before connect', () => {
    sdkClientMock.getServerCapabilities.mockReturnValue(undefined)
    sdkClientMock.getServerVersion.mockReturnValue(undefined)
    sdkClientMock.getInstructions.mockReturnValue(undefined)

    expect(client.serverCapabilities).toBeUndefined()
    expect(client.serverVersion).toBeUndefined()
    expect(client.serverInstructions).toBeUndefined()
  })

  it('returns serverCapabilities after connect', async () => {
    const caps = { tools: {} }
    sdkClientMock.getServerCapabilities.mockReturnValue(caps)

    await client.connect()

    expect(client.serverCapabilities).toBe(caps)
  })

  it('returns serverVersion after connect', async () => {
    const version = { name: 'my-server', version: '1.2.3' }
    sdkClientMock.getServerVersion.mockReturnValue(version)

    await client.connect()

    expect(client.serverVersion).toBe(version)
  })

  it('returns serverInstructions after connect', async () => {
    sdkClientMock.getInstructions.mockReturnValue('Use this server for X.')

    await client.connect()

    expect(client.serverInstructions).toBe('Use this server for X.')
  })

  it('connectionState is disconnected before connect', () => {
    expect(client.connectionState).toBe('disconnected')
  })

  it('connectionState is connected after successful connect', async () => {
    await client.connect()
    expect(client.connectionState).toBe('connected')
  })
})

describe('continueOnError', () => {
  let sdkClientMock: {
    connect: ReturnType<typeof vi.fn>
    listTools: ReturnType<typeof vi.fn>
    callTool: ReturnType<typeof vi.fn>
    setNotificationHandler: ReturnType<typeof vi.fn>
    setRequestHandler: ReturnType<typeof vi.fn>
    getServerCapabilities: ReturnType<typeof vi.fn>
    getServerVersion: ReturnType<typeof vi.fn>
    getInstructions: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('throws on connection failure by default', async () => {
    const client = new McpClient({ applicationName: 'TestApp', transport: mockTransport })
    sdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
    sdkClientMock.connect.mockRejectedValue(new Error('connection refused'))

    await expect(client.connect()).rejects.toThrow('connection refused')
  })

  it('swallows connection failure when continueOnError is true', async () => {
    const client = new McpClient({ applicationName: 'TestApp', transport: mockTransport, continueOnError: true })
    sdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
    sdkClientMock.connect.mockRejectedValue(new Error('connection refused'))

    await expect(client.connect()).resolves.toBeUndefined()
  })

  it('logs a warning when continueOnError swallows a connection failure', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const client = new McpClient({ applicationName: 'TestApp', transport: mockTransport, continueOnError: true })
    sdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
    sdkClientMock.connect.mockRejectedValue(new Error('connection refused'))

    await client.connect()

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('MCP server failed to connect'))
  })

  it('listTools returns empty array when continueOnError and connection failed', async () => {
    const client = new McpClient({ applicationName: 'TestApp', transport: mockTransport, continueOnError: true })
    sdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
    sdkClientMock.connect.mockRejectedValue(new Error('connection refused'))

    const tools = await client.listTools()

    expect(tools).toEqual([])
  })

  it('callTool throws when continueOnError and connection failed', async () => {
    const client = new McpClient({ applicationName: 'TestApp', transport: mockTransport, continueOnError: true })
    sdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
    sdkClientMock.connect.mockRejectedValue(new Error('connection refused'))
    const tool = new McpTool({ name: 'my_tool', description: '', inputSchema: {}, client })

    await expect(client.callTool(tool, {})).rejects.toThrow(
      'MCP server failed to connect. Call connect(true) to retry.'
    )
  })

  it('does not retry connection on subsequent calls after continueOnError failure', async () => {
    const client = new McpClient({ applicationName: 'TestApp', transport: mockTransport, continueOnError: true })
    sdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
    sdkClientMock.connect.mockRejectedValue(new Error('connection refused'))

    await client.listTools()
    await client.listTools()

    expect(sdkClientMock.connect).toHaveBeenCalledTimes(1)
  })

  it('recovers after explicit connect(true) when server comes back', async () => {
    const client = new McpClient({ applicationName: 'TestApp', transport: mockTransport, continueOnError: true })
    sdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
    sdkClientMock.connect.mockRejectedValueOnce(new Error('connection refused'))
    sdkClientMock.listTools.mockResolvedValue({ tools: [] })

    const firstTools = await client.listTools()
    expect(firstTools).toEqual([])
    expect(client.connectionState).toBe('failed')

    await client.connect(true)
    const secondTools = await client.listTools()

    expect(secondTools).toEqual([])
    expect(client.connectionState).toBe('connected')
    expect(sdkClientMock.connect).toHaveBeenCalledTimes(2)
  })
})

describe('log routing', () => {
  let notificationHandler: (notification: { params: LoggingMessageNotificationParams }) => void
  let sdkClientMock: {
    connect: ReturnType<typeof vi.fn>
    setNotificationHandler: ReturnType<typeof vi.fn>
    setRequestHandler: ReturnType<typeof vi.fn>
    getServerCapabilities: ReturnType<typeof vi.fn>
    getServerVersion: ReturnType<typeof vi.fn>
    getInstructions: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    vi.clearAllMocks()
    new McpClient({ applicationName: 'TestApp', transport: mockTransport })
    sdkClientMock = vi.mocked(Client).mock.results.at(-1)!.value
    // Handler is registered in the constructor — read it from the first setNotificationHandler call
    notificationHandler = sdkClientMock.setNotificationHandler.mock.calls[0]![1]
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('routes debug level to logger.debug', () => {
    const spy = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    notificationHandler({ params: { level: 'debug', data: 'hello' } })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('hello'))
  })

  it('routes info level to logger.info', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    notificationHandler({ params: { level: 'info', data: 'hello' } })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('hello'))
  })

  it('routes notice level to logger.info', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    notificationHandler({ params: { level: 'notice', data: 'hello' } })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('hello'))
  })

  it('routes warning level to logger.warn', () => {
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    notificationHandler({ params: { level: 'warning', data: 'hello' } })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('hello'))
  })

  it('routes error level to logger.error', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    notificationHandler({ params: { level: 'error', data: 'hello' } })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('hello'))
  })

  it('routes critical level to logger.error', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    notificationHandler({ params: { level: 'critical', data: 'hello' } })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('hello'))
  })

  it('routes alert level to logger.error', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    notificationHandler({ params: { level: 'alert', data: 'hello' } })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('hello'))
  })

  it('routes emergency level to logger.error', () => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    notificationHandler({ params: { level: 'emergency', data: 'hello' } })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('hello'))
  })

  it('includes logger name and data in the message', () => {
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    notificationHandler({ params: { level: 'info', logger: 'my-server', data: { key: 'val' } } })
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('my-server'))
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('key'))
  })

  it('calls custom logHandler when provided', () => {
    const customHandler = vi.fn()
    new McpClient({ applicationName: 'TestApp', transport: mockTransport, logHandler: customHandler })
    const customSdkMock = vi.mocked(Client).mock.results.at(-1)!.value
    const capturedHandler = customSdkMock.setNotificationHandler.mock.calls[0]![1]

    const params: LoggingMessageNotificationParams = { level: 'info', data: 'test' }
    capturedHandler({ params })

    expect(customHandler).toHaveBeenCalledWith(params)
  })
})

describe('McpClient transport resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('constructs StreamableHTTPClientTransport when url is provided', () => {
    new McpClient({ url: 'https://mcp.example.com' })
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(new URL('https://mcp.example.com'), {})
  })

  it('constructs ClientCredentialsProvider when auth is provided', () => {
    new McpClient({ url: 'https://mcp.example.com', auth: { clientId: 'id', clientSecret: 'secret' } })
    expect(ClientCredentialsProvider).toHaveBeenCalledWith({ clientId: 'id', clientSecret: 'secret' })
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(new URL('https://mcp.example.com'), {
      authProvider: expect.anything(),
    })
  })

  it('passes scopes as space-separated string', () => {
    new McpClient({
      url: 'https://mcp.example.com',
      auth: { clientId: 'id', clientSecret: 'secret', scopes: ['read', 'write'] },
    })
    expect(ClientCredentialsProvider).toHaveBeenCalledWith({
      clientId: 'id',
      clientSecret: 'secret',
      scope: 'read write',
    })
  })

  it('passes custom authProvider to transport', () => {
    const customProvider = { redirectUrl: undefined, clientMetadata: {} } as never
    new McpClient({ url: 'https://mcp.example.com', authProvider: customProvider })
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(new URL('https://mcp.example.com'), {
      authProvider: customProvider,
    })
  })

  it('throws when both transport and url are provided', () => {
    expect(() => new McpClient({ transport: mockTransport, url: 'https://mcp.example.com' } as never)).toThrow(
      'provide either "transport" or "url", not both'
    )
  })

  it('throws when neither transport nor url is provided', () => {
    expect(() => new McpClient({} as never)).toThrow('either "transport" or "url" must be provided')
  })

  it('throws when auth is provided with transport', () => {
    expect(
      () => new McpClient({ transport: mockTransport, auth: { clientId: 'x', clientSecret: 'y' } } as never)
    ).toThrow('"auth", "authProvider", and "headers" require "url"')
  })

  it('throws when both auth and authProvider are provided', () => {
    const customProvider = {} as never
    expect(
      () =>
        new McpClient({
          url: 'https://mcp.example.com',
          auth: { clientId: 'x', clientSecret: 'y' },
          authProvider: customProvider,
        } as never)
    ).toThrow('provide either "auth" or "authProvider", not both')
  })

  it('accepts URL instance for url field', () => {
    const url = new URL('https://mcp.example.com/path')
    new McpClient({ url })
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(url, {})
  })

  it('passes headers as requestInit to transport', () => {
    new McpClient({ url: 'https://mcp.example.com', headers: { 'X-Api-Key': 'abc' } })
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(new URL('https://mcp.example.com'), {
      requestInit: { headers: { 'X-Api-Key': 'abc' } },
    })
  })

  it('passes both auth and headers to transport', () => {
    new McpClient({
      url: 'https://mcp.example.com',
      auth: { clientId: 'id', clientSecret: 'secret' },
      headers: { 'X-Trace': '123' },
    })
    expect(ClientCredentialsProvider).toHaveBeenCalledWith({ clientId: 'id', clientSecret: 'secret' })
    expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(new URL('https://mcp.example.com'), {
      authProvider: expect.anything(),
      requestInit: { headers: { 'X-Trace': '123' } },
    })
  })

  it('throws when headers is provided with transport', () => {
    expect(() => new McpClient({ transport: mockTransport, headers: { 'X-Foo': 'bar' } } as never)).toThrow(
      '"auth", "authProvider", and "headers" require "url"'
    )
  })
})
