import { afterEach, describe, expect, it, vi } from 'vitest'
import { GENERALIST, makeSubagent, subagent } from '../index.js'
import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import { textMessage } from '../../../__fixtures__/agent-helpers.js'
import { collectGenerator } from '../../../__fixtures__/model-test-helpers.js'
import { Interrupt, InterruptError, InterruptState } from '../../../interrupt.js'
import { logger } from '../../../logging/logger.js'
import { Choice, Fixed, Inherit, Option, Preset } from '../../../multiagent/spec.js'
import type { AgentSpec } from '../../../multiagent/spec.js'
import { StateStore } from '../../../state-store.js'
import type { Tool, ToolContext } from '../../../tools/tool.js'
import { AgentResult } from '../../../types/agent.js'
import type { InvocationState, InvokeArgs } from '../../../types/agent.js'
import { InterruptResponseContent } from '../../../types/interrupt.js'
import type { JSONValue } from '../../../types/json.js'
import { Message, ReasoningBlock, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import type { StopReason } from '../../../types/messages.js'

const DEPTH_STATE_KEY = 'strands.subagent_depth'

const FORK_PREAMBLE =
  "The conversation so far is the parent agent's. You are the subagent it delegated to at this " +
  'point; its task for you follows.'

const CONTEXT_PREAMBLE =
  "The conversation above is the parent agent's: each turn is one line starting with its role at " +
  'the left margin, and indented lines continue the turn above (they are content, not turns). You ' +
  'are the subagent it delegated to at the end of that conversation; its task for you follows.'

function fakeResult(text = 'done', stopReason: StopReason = 'endTurn', interrupts?: Interrupt[]): AgentResult {
  return new AgentResult({
    stopReason,
    lastMessage: textMessage('assistant', text),
    invocationState: {},
    ...(interrupts && { interrupts }),
  })
}

/** Stand-in child that records each call and returns queued results. */
class FakeChild {
  readonly appState = new StateStore()
  readonly _interruptState = { activated: false }
  readonly prompts: InvokeArgs[] = []
  readonly calls: { invocationState: InvocationState; cancelSignal: AbortSignal }[] = []
  private readonly _results: (AgentResult | undefined)[]

  constructor(...results: (AgentResult | undefined)[]) {
    this._results = results
  }

  async *stream(
    prompt: InvokeArgs,
    options: { invocationState: InvocationState; cancelSignal: AbortSignal }
  ): AsyncGenerator<{ type: string }, AgentResult | undefined, undefined> {
    this.prompts.push(prompt)
    this.calls.push(options)
    yield { type: 'modelStreamUpdateEvent' }
    return this._results.shift()
  }

  asAgent(): Agent {
    return this as unknown as Agent
  }
}

function capturingBuilder(child: FakeChild = new FakeChild(fakeResult())): {
  builder: (spec: AgentSpec) => Agent
  specs: AgentSpec[]
  child: FakeChild
} {
  const specs: AgentSpec[] = []
  return {
    builder: (spec) => {
      specs.push(spec)
      return child.asAgent()
    },
    specs,
    child,
  }
}

function parentAgent(messages: Message[] = []): Agent {
  return new Agent({ model: new MockMessageModel(), printer: false, messages })
}

function createContext(
  input: JSONValue,
  options: { agent?: Agent; toolUseId?: string; invocationState?: InvocationState; cancelSignal?: AbortSignal } = {}
): ToolContext {
  return {
    toolUse: { name: 'subagent', toolUseId: options.toolUseId ?? 't1', input },
    agent: options.agent ?? parentAgent(),
    invocationState: options.invocationState ?? {},
    cancelSignal: options.cancelSignal ?? new AbortController().signal,
    interrupt: (): never => {
      throw new Error('interrupt not available in test context')
    },
  } as unknown as ToolContext
}

async function run(tool: Tool, input: JSONValue, options: Parameters<typeof createContext>[1] = {}) {
  return collectGenerator(tool.stream(createContext(input, options)))
}

function resultText(result: ToolResultBlock): string {
  return (result.content[0] as TextBlock).text
}

/** Role and serialized content, ignoring the per-message tracking id. */
function shape(message: Message): { role: string; content: unknown[] } {
  return { role: message.role, content: message.content.map((block) => block.toJSON()) }
}

function properties(tool: Tool): Record<string, Record<string, unknown>> {
  return tool.toolSpec.inputSchema!.properties as Record<string, Record<string, unknown>>
}

describe('subagent tool', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('tool metadata', () => {
    const task = { type: 'string', description: expect.any(String) }

    it('exposes the default name, description, and schema', () => {
      expect(subagent.name).toBe('subagent')
      expect(subagent.toolSpec.description).toContain('Available subagents (agent_type):\n- generalist:')
      expect(subagent.toolSpec.inputSchema).toEqual({
        type: 'object',
        properties: {
          task,
          agent_type: { type: 'string', enum: ['generalist'], description: expect.stringContaining("'generalist'") },
          instructions: { type: 'string', description: expect.any(String) },
        },
        required: ['task'],
      })
    })

    it('uses a custom name', () => {
      expect(makeSubagent({ name: 'delegate' }).toolSpec.name).toBe('delegate')
    })

    it('uses a custom description with the presets appended', () => {
      expect(makeSubagent({ description: 'Hand off research.' }).toolSpec.description).toBe(
        `Hand off research.\n\nAvailable subagents (agent_type):\n- generalist: ${GENERALIST.description}`
      )
      expect(makeSubagent({ description: 'Hand off research.', presets: {} }).toolSpec.description).toBe(
        'Hand off research.'
      )
    })

    it('derives parameters from Choice axes', () => {
      const tool = makeSubagent({
        presets: {},
        instructions: new Choice(['concise', 'verbose']),
        model: new Choice(['fast', 'deep']),
        context: new Choice(['none', 'all']),
        tools: new Choice(['read', 'shell'], true),
        mcpServers: new Choice(['fs', 'api'], true),
      })
      const list = (values: string[]): unknown => ({
        type: 'array',
        items: { type: 'string', enum: values },
        description: expect.any(String),
      })
      expect(tool.toolSpec.inputSchema).toEqual({
        type: 'object',
        properties: {
          task,
          instructions: { type: 'string', enum: ['concise', 'verbose'], description: expect.any(String) },
          tools: list(['read', 'shell']),
          mcp_servers: list(['fs', 'api']),
          model: { type: 'string', enum: ['fast', 'deep'], description: expect.any(String) },
          context: { type: 'string', enum: ['none', 'all'], description: expect.any(String) },
          last_messages: { type: 'integer', description: expect.any(String) },
        },
        required: ['task'],
      })
    })

    it.each([
      [
        'omits last_messages when the only context option is none',
        { context: new Choice(['none']) },
        ['task', 'instructions', 'context'],
      ],
      [
        'hides Fixed and Inherit axes from the model',
        { instructions: new Fixed('x'), tools: new Inherit(), model: new Inherit(), context: new Fixed('none') },
        ['task'],
      ],
    ])('%s', (_, axes, expected) => {
      expect(Object.keys(properties(makeSubagent({ presets: {}, ...axes })))).toEqual(expected)
    })

    it('adds an agent_type parameter naming the presets and default', () => {
      const tool = makeSubagent({
        presets: {
          generalist: GENERALIST,
          reviewer: new Preset({ instructions: 'review', description: 'reviews diffs' }),
        },
        defaultPreset: 'generalist',
        instructions: new Fixed(undefined),
      })
      expect(properties(tool)).toEqual({
        task,
        agent_type: {
          type: 'string',
          enum: ['generalist', 'reviewer'],
          description: expect.stringContaining("'generalist'"),
        },
      })
      expect(tool.toolSpec.description).toContain('- reviewer: reviews diffs')
    })
  })

  describe('factory validation', () => {
    it.each([
      [{ name: '' }, 'name must be a non-empty string.'],
      [{ description: '' }, 'description must be a non-empty string.'],
      [{ maxDepth: 0 }, 'maxDepth must be a positive integer (>= 1).'],
      [{ maxDepth: -1 }, 'maxDepth must be a positive integer (>= 1).'],
      [{ maxDepth: 1.5 }, 'maxDepth must be a positive integer (>= 1).'],
      [{ tools: new Choice([], true) }, /^tools: new Choice\(\[\]\) offers no options/],
      [{ tools: new Choice(['read', 'shell']) }, /^tools: new Choice\(\.\.\.\) must set multiple to true/],
      [{ mcpServers: new Choice([], true) }, /^mcpServers: new Choice\(\[\]\) offers no options/],
      [{ mcpServers: new Choice(['fs']) }, /^mcpServers: new Choice\(\.\.\.\) must set multiple to true/],
      [{ defaultPreset: 'reseacher' }, "defaultPreset 'reseacher' is not one of the presets: generalist."],
      [{ context: new Fixed('al') }, 'context mode "al" must be one of: none, all, no_tools.'],
      [
        { context: new Choice(['none', new Option('shared', 'everything')]) },
        'context mode "everything" must be one of',
      ],
    ])('rejects invalid options %#', (options, message) => {
      expect(() => makeSubagent(options)).toThrow(message)
    })
  })

  describe('resolution', () => {
    it('builds a child from the default preset and returns its output', async () => {
      const { builder, specs } = capturingBuilder(new FakeChild(fakeResult('the answer')))
      const tool = makeSubagent({ builder })

      const { items, result } = await run(tool, { task: 'do it' })

      expect(result).toEqual(
        new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('the answer')] })
      )
      expect(specs[0]!.instructions).toBe(GENERALIST.instructions)
      expect(items.map((item) => item.data)).toEqual([{ type: 'modelStreamUpdateEvent' }])
    })

    it('passes a copy of the invocation state and the tool cancel signal to the child', async () => {
      const { builder, child } = capturingBuilder()
      const invocationState = { scratch: 1 }
      const cancelSignal = new AbortController().signal

      await run(makeSubagent({ builder }), { task: 'x' }, { invocationState, cancelSignal })

      expect(child.calls[0]!.invocationState).not.toBe(invocationState)
      expect(child.calls[0]!.invocationState).toEqual({ scratch: 1 })
      expect(child.calls[0]!.cancelSignal).toBe(cancelSignal)
    })

    it.each([
      ['maps tools Choice option names to values', ['readonly'], ['read']],
      ['clamps off-enum tools', ['readonly', 'write'], ['read']],
    ])('%s', async (_, requested, expected) => {
      const { builder, specs } = capturingBuilder()
      const tool = makeSubagent({
        builder,
        tools: new Choice([new Option('readonly', 'read'), new Option('sh', 'shell')], true),
      })

      await run(tool, { task: 'x', tools: requested })

      expect(specs[0]!.tools).toEqual(expected)
    })

    it('ignores model values for Fixed axes', async () => {
      const { builder, specs, child } = capturingBuilder()
      const tool = makeSubagent({ builder, presets: {}, instructions: new Fixed('pinned'), context: new Fixed('none') })

      await run(
        tool,
        { task: 'x', instructions: 'override', context: 'all' },
        { agent: parentAgent([textMessage('user', 'hi')]) }
      )

      expect(specs[0]!.instructions).toBe('pinned')
      expect(child.prompts[0]).toBe('x')
    })

    it.each([
      [{ task: 'x', agent_type: 'nope' }, /Unknown agent_type/],
      [{}, /Missing required parameter 'task'/],
      [{ task: '' }, /Missing required parameter 'task'/],
      [{ task: '   ' }, /Missing required parameter 'task'/],
      [{ task: 42 }, /Missing required parameter 'task'/],
      [{ task: 'x', instructions: ['not', 'a', 'string'] }, "Parameter 'instructions' must be a string."],
    ])('rejects invalid input %j as an error result without building a child', async (input, message) => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const { builder, specs } = capturingBuilder()

      const { result } = await run(makeSubagent({ builder }), input as JSONValue)

      expect(result.status).toBe('error')
      expect(resultText(result)).toMatch(message)
      expect(specs).toHaveLength(0)
    })
  })

  describe('context modes', () => {
    const framed = (task: string): TextBlock => new TextBlock(`${FORK_PREAMBLE}\n\n${task}`)
    const allContext = (): Choice => new Choice(['none', 'all'])
    const toolResult = (): ToolResultBlock =>
      new ToolResultBlock({ toolUseId: 'r1', status: 'success', content: [new TextBlock('A')] })
    const toolUse = (toolUseId: string, name: string): Message =>
      new Message({ role: 'assistant', content: [new ToolUseBlock({ toolUseId, name, input: {} })] })

    it("forks messages for 'all', dropping reasoning and in-flight tool calls", async () => {
      const { builder, child } = capturingBuilder()
      const tool = makeSubagent({ builder, context: allContext() })
      const parent = parentAgent([
        textMessage('user', 'go'),
        new Message({
          role: 'assistant',
          content: [
            new ReasoningBlock({ text: 'think', signature: 'sig' }),
            new ToolUseBlock({ toolUseId: 'r1', name: 'read', input: {} }),
          ],
        }),
        new Message({ role: 'user', content: [toolResult()] }),
        // In-flight (no result yet): dropped.
        toolUse('t1', 'subagent'),
      ])

      await run(tool, { task: 'do X', context: 'all' }, { agent: parent })

      const prompt = child.prompts[0] as Message[]
      expect(prompt.map(shape)).toEqual([
        shape(textMessage('user', 'go')),
        { role: 'assistant', content: [{ toolUse: { toolUseId: 'r1', name: 'read', input: {} } }] },
        { role: 'user', content: [toolResult().toJSON(), framed('do X').toJSON()] },
      ])
      // The parent's messages are copied, not shared.
      expect(prompt[0]).not.toBe(parent.messages[0])
      expect(parent.messages).toHaveLength(4)
    })

    it.each([
      [
        'appends a user turn when the last forked message is from the assistant',
        [textMessage('user', 'hi'), textMessage('assistant', 'hello')],
        {},
        [
          textMessage('user', 'hi'),
          textMessage('assistant', 'hello'),
          new Message({ role: 'user', content: [framed('x')] }),
        ],
      ],
      [
        'merges consecutive same-role messages left by dropped tool calls',
        [textMessage('user', 'one'), toolUse('x1', 'sub'), textMessage('user', 'two')],
        {},
        [new Message({ role: 'user', content: [new TextBlock('one'), new TextBlock('two'), framed('x')] })],
      ],
      [
        'widens last_messages so a tool pair is never split',
        [
          textMessage('user', 'old'),
          textMessage('assistant', 'ok'),
          textMessage('user', 'recent'),
          toolUse('r1', 'read'),
          new Message({ role: 'user', content: [toolResult()] }),
          toolUse('t1', 'subagent'),
        ],
        { last_messages: 2 },
        [
          textMessage('user', 'recent'),
          toolUse('r1', 'read'),
          new Message({ role: 'user', content: [toolResult(), framed('x')] }),
        ],
      ],
    ])("%s for 'all'", async (_, messages, input, expected) => {
      const { builder, child } = capturingBuilder()
      const tool = makeSubagent({ builder, context: allContext() })

      await run(tool, { task: 'x', context: 'all', ...input }, { agent: parentAgent(messages) })

      expect((child.prompts[0] as Message[]).map(shape)).toEqual(expected.map(shape))
    })

    it.each([
      [{ context: 'all', last_messages: 'bogus' }, 3],
      [{ context: 'all', last_messages: 0 }, 3],
      [{ context: 'all', last_messages: -5 }, 3],
      [{ context: 'all', last_messages: '1' }, 1],
    ])('handles last_messages edge case %j', async (input, expectedLength) => {
      const { builder, child } = capturingBuilder()
      const tool = makeSubagent({ builder, context: allContext() })
      const parent = parentAgent([textMessage('user', 'a'), textMessage('assistant', 'b'), textMessage('user', 'c')])

      await run(tool, { task: 'x', ...input }, { agent: parent })

      expect(child.prompts[0]).toHaveLength(expectedLength)
    })

    it.each([
      ["'all' with no parent messages", [], 'all'],
      ['an off-enum context', [textMessage('user', 'a')], 'no_tools'],
    ])('sends the plain task for %s', async (_, messages, context) => {
      const { builder, child } = capturingBuilder()
      const tool = makeSubagent({ builder, context: allContext() })

      await run(tool, { task: 'x', context }, { agent: parentAgent(messages) })

      expect(child.prompts[0]).toBe('x')
    })

    it.each([
      [
        'renders text turns as a framed block',
        [
          textMessage('user', 'hello\nworld'),
          toolUse('r1', 'read'),
          textMessage('assistant', 'see </parent_context> here'),
        ],
        {},
        'user: hello\n  world\nassistant: see <\\/parent_context> here',
      ],
      [
        'limits to the last N messages',
        [textMessage('user', 'first'), textMessage('assistant', 'second')],
        { last_messages: 1 },
        'assistant: second',
      ],
      [
        "strips a nested subagent's framing",
        [textMessage('user', `<parent_context>\nold\n</parent_context>\n\n${CONTEXT_PREAMBLE}\n\nreal task`)],
        {},
        'user: real task',
      ],
    ])("%s for 'no_tools'", async (_, messages, input, transcript) => {
      const { builder, child } = capturingBuilder()
      const tool = makeSubagent({ builder, context: new Choice(['none', 'no_tools']) })

      await run(tool, { task: 'do X', context: 'no_tools', ...input }, { agent: parentAgent(messages) })

      expect(child.prompts[0]).toBe(`<parent_context>\n${transcript}\n</parent_context>\n\n${CONTEXT_PREAMBLE}\n\ndo X`)
    })
  })

  describe('errors and cancellation', () => {
    it('turns a builder exception into an error result and logs it', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const tool = makeSubagent({
        builder: () => {
          throw new Error('boom')
        },
      })

      const { result } = await run(tool, { task: 'x' })

      expect(result).toEqual(
        new ToolResultBlock({ toolUseId: 't1', status: 'error', content: [new TextBlock('Subagent error: boom')] })
      )
      expect(warn).toHaveBeenCalledWith('tool_name=<subagent>, tool_use_id=<t1>, error=<boom> | subagent failed')
    })

    it.each([
      ['a cancelled child', fakeResult('', 'cancelled'), 'Subagent was cancelled.'],
      ['a missing child result', undefined, 'Subagent produced no result.'],
    ])('turns %s into an error result', async (_, childResult, message) => {
      const { builder } = capturingBuilder(new FakeChild(childResult))

      const { result } = await run(makeSubagent({ builder }), { task: 'x' })

      expect(result).toEqual(
        new ToolResultBlock({ toolUseId: 't1', status: 'error', content: [new TextBlock(message)] })
      )
    })
  })

  describe('depth tracking', () => {
    it('refuses to delegate once the depth is exhausted', async () => {
      const { builder, specs } = capturingBuilder()
      const tool = makeSubagent({ builder, maxDepth: 3, name: 'delegate' })
      const parent = parentAgent()
      parent.appState.set(DEPTH_STATE_KEY, 0)

      const { result } = await run(tool, { task: 'x' }, { agent: parent })

      expect(result.status).toBe('error')
      expect(resultText(result)).toBe(
        'Delegation depth limit reached (3 levels); you cannot delegate further. ' +
          'Complete this task yourself instead of calling delegate again.'
      )
      expect(specs).toHaveLength(0)
    })

    it.each([
      ['starts at maxDepth and decrements', { maxDepth: 3 }, undefined, 2],
      ['starts at the default maxDepth of 2', {}, undefined, 1],
      ['decrements from the depth stored on the parent', {}, 1, 0],
    ])('%s', async (_, options, parentDepth, expected) => {
      const { builder, child } = capturingBuilder()
      const parent = parentAgent()
      if (parentDepth !== undefined) parent.appState.set(DEPTH_STATE_KEY, parentDepth)

      await run(makeSubagent({ builder, ...options }), { task: 'x' }, { agent: parent })

      expect(child.appState.get(DEPTH_STATE_KEY)).toBe(expected)
    })
  })

  describe('interrupts', () => {
    it('namespaces child interrupts on the parent and resumes the same child', async () => {
      const childInterrupt = new Interrupt({ id: 'i1', name: 'confirm', reason: 'ok?' })
      const child = new FakeChild(fakeResult('', 'interrupt', [childInterrupt]), fakeResult('resumed'))
      const { builder, specs } = capturingBuilder(child)
      const tool = makeSubagent({ builder })
      const parent = parentAgent()

      const error = await run(tool, { task: 'x' }, { agent: parent }).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(InterruptError)
      expect((error as InterruptError).interrupts).toMatchObject([
        { id: 'subagent:t1:i1', name: 'confirm', reason: 'ok?', source: 'tool' },
      ])
      expect(Object.keys(parent._interruptState.interrupts)).toEqual(['subagent:t1:i1'])

      // The parent resumes with an answer; the same child receives it under its own id.
      parent._interruptState.activate()
      parent._interruptState.resume([new InterruptResponseContent({ interruptId: 'subagent:t1:i1', response: 'yes' })])
      child._interruptState.activated = true

      const { result } = await run(tool, { task: 'x' }, { agent: parent })

      expect(resultText(result)).toBe('resumed')
      expect(child.prompts[1]).toEqual([new InterruptResponseContent({ interruptId: 'i1', response: 'yes' })])
      expect(specs).toHaveLength(1)
    })

    it('raises the interrupts again when none were answered', async () => {
      const state = new InterruptState()
      state.registerInterrupt(new Interrupt({ id: 'subagent:t1:i1', name: 'confirm' }))
      state.activate()
      const parent = parentAgent()
      parent._interruptState = state

      const error = await run(
        makeSubagent({ builder: capturingBuilder().builder }),
        { task: 'x' },
        { agent: parent }
      ).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(InterruptError)
      expect((error as InterruptError).interrupts.map((interrupt) => interrupt.id)).toEqual(['subagent:t1:i1'])
    })

    it('returns an error when the interrupted child is no longer available', async () => {
      vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const parent = parentAgent()
      parent._interruptState.registerInterrupt(new Interrupt({ id: 'subagent:t1:i1', name: 'confirm' }))
      parent._interruptState.activate()
      parent._interruptState.resume([new InterruptResponseContent({ interruptId: 'subagent:t1:i1', response: 'yes' })])
      const { builder, specs } = capturingBuilder()

      const { result } = await run(makeSubagent({ builder }), { task: 'x' }, { agent: parent })

      expect(result.status).toBe('error')
      expect(resultText(result)).toMatch(/did NOT run/)
      expect(specs).toHaveLength(0)
    })

    it('rethrows child interrupts as-is when the parent has no interrupt state', async () => {
      const childInterrupt = new Interrupt({ id: 'i1', name: 'confirm' })
      const { builder } = capturingBuilder(new FakeChild(fakeResult('', 'interrupt', [childInterrupt])))
      const parent = { appState: new StateStore(), messages: [] } as unknown as Agent

      const error = await run(makeSubagent({ builder }), { task: 'x' }, { agent: parent }).catch(
        (caught: unknown) => caught
      )

      expect((error as InterruptError).interrupts).toEqual([childInterrupt])
    })
  })

  describe('with real agents', () => {
    it('delegates to a child built from the parent, propagating a child tool interrupt and resuming it', async () => {
      let confirmed = 0
      const confirmTool = createMockTool('confirmTool', (context) => {
        context.interrupt({ name: 'confirm', reason: 'Please confirm' })
        confirmed += 1
        return 'ok'
      })
      // The child inherits the parent's model, so turns are consumed in order across both agents.
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'subagent', toolUseId: 't1', input: { task: 'confirm it' } })
        .addTurn({ type: 'toolUseBlock', name: 'confirmTool', toolUseId: 'inner-1', input: {} })
        .addTurn({ type: 'textBlock', text: 'child report' })
        .addTurn({ type: 'textBlock', text: 'parent done' })
      const parent = new Agent({ model, tools: [subagent, confirmTool], printer: false })

      const interrupted = await parent.invoke('go')

      expect(interrupted.stopReason).toBe('interrupt')
      const interruptId = 'subagent:t1:tool:inner-1:confirm'
      expect(interrupted.interrupts).toMatchObject([{ id: interruptId, name: 'confirm', reason: 'Please confirm' }])

      const result = await parent.invoke([new InterruptResponseContent({ interruptId, response: 'yes' })])

      expect(result.stopReason).toBe('endTurn')
      expect(result.toString()).toBe('parent done')
      expect(confirmed).toBe(1)
      expect(parent.messages[2]!.content).toEqual([
        new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('child report')] }),
      ])
    })

    it('resumes the same child across consecutive interrupts', async () => {
      const seen: string[] = []
      const confirmTool = createMockTool('confirmTool', (context) => {
        const response = context.interrupt({ name: 'confirm', reason: 'Please confirm' })
        seen.push(String(response))
        return 'ok'
      })
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'subagent', toolUseId: 't1', input: { task: 'confirm twice' } })
        .addTurn({ type: 'toolUseBlock', name: 'confirmTool', toolUseId: 'inner-1', input: {} })
        .addTurn({ type: 'toolUseBlock', name: 'confirmTool', toolUseId: 'inner-2', input: {} })
        .addTurn({ type: 'textBlock', text: 'child report' })
        .addTurn({ type: 'textBlock', text: 'parent done' })
      const parent = new Agent({ model, tools: [subagent, confirmTool], printer: false })

      const first = await parent.invoke('go')
      expect(first.interrupts).toMatchObject([{ id: 'subagent:t1:tool:inner-1:confirm' }])

      const second = await parent.invoke([
        new InterruptResponseContent({ interruptId: 'subagent:t1:tool:inner-1:confirm', response: 'A' }),
      ])
      expect(second.interrupts).toMatchObject([{ id: 'subagent:t1:tool:inner-2:confirm' }])

      const result = await parent.invoke([
        new InterruptResponseContent({ interruptId: 'subagent:t1:tool:inner-2:confirm', response: 'B' }),
      ])

      expect(result.toString()).toBe('parent done')
      expect(seen).toEqual(['A', 'B'])
    })

    it('delegates two levels deep from a parent with an auto context manager', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'toolUseBlock', name: 'subagent', toolUseId: 't1', input: { task: 'delegate again' } })
        .addTurn({ type: 'toolUseBlock', name: 'subagent', toolUseId: 't2', input: { task: 'do it' } })
        .addTurn({ type: 'textBlock', text: 'grandchild report' })
        .addTurn({ type: 'textBlock', text: 'child report' })
        .addTurn({ type: 'textBlock', text: 'parent done' })
      const parent = new Agent({ model, tools: [subagent], printer: false, contextManager: 'auto' })

      const result = await parent.invoke('go')

      expect(result.toString()).toBe('parent done')
      expect(parent.messages[2]!.content).toEqual([
        new ToolResultBlock({ toolUseId: 't1', status: 'success', content: [new TextBlock('child report')] }),
      ])
    })
  })
})
