import { describe, expect, it, vi } from 'vitest'
import { Todos } from '../plugin.js'
import type { TodoItem } from '../plugin.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { InvokeModelStage } from '../../../middleware/index.js'
import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { createMockTool } from '../../../__fixtures__/tool-helpers.js'
import type { MockAgent } from '../../../__fixtures__/agent-helpers.js'
import type { InjectionContext } from '../../../injection/types.js'
import type { InvokableTool, ToolContext } from '../../../tools/tool.js'
import type { MessageData } from '../../../types/messages.js'

function sampleTodos(): TodoItem[] {
  return [
    { content: 'Read code', activeForm: 'Reading code', status: 'completed' },
    { content: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' },
    { content: 'Ship', activeForm: 'Shipping', status: 'pending' },
  ]
}

function toolContext(agent: MockAgent): ToolContext {
  return { agent } as unknown as ToolContext
}

function injectionContext(agent: MockAgent): InjectionContext {
  return { agent, appState: agent.appState, messages: [] } as unknown as InjectionContext
}

async function write(plugin: Todos, agent: MockAgent, todos: TodoItem[]): Promise<string> {
  const todoWrite = plugin.getTools()[0] as InvokableTool<{ todos: TodoItem[] }, string>
  return todoWrite.invoke({ todos }, toolContext(agent))
}

function hasReminder(request: MessageData[]): boolean {
  return request.some((message) =>
    message.content.some((block) => (block as { text?: string }).text?.includes('Your current todo list') ?? false)
  )
}

function renderReminder(plugin: Todos, agent: MockAgent): string | undefined {
  return (plugin as unknown as { _renderReminder(context: InjectionContext): string | undefined })._renderReminder(
    injectionContext(agent)
  )
}

describe('Todos', () => {
  it('persists the list and reports what is left', async () => {
    const agent = createMockAgent()

    const result = await write(new Todos(), agent, sampleTodos())

    expect(agent.appState.get('todos')).toEqual(sampleTodos())
    expect(result).toBe('2 todos remaining\n  [completed] Read code\n  [in_progress] Writing tests\n  [pending] Ship')
  })

  it('falls back to the content of an in-progress item with no active form', async () => {
    const todos: TodoItem[] = [{ content: 'Ship', activeForm: '', status: 'in_progress' }]

    const result = await write(new Todos(), createMockAgent(), todos)

    expect(result).toBe('1 todos remaining\n  [in_progress] Ship')
  })

  it('clears the state when given an empty list', async () => {
    const agent = createMockAgent()
    const plugin = new Todos()
    await write(plugin, agent, sampleTodos())

    const result = await write(plugin, agent, [])

    expect(result).toBe('Todo list cleared')
    expect(agent.appState.get('todos')).toBeUndefined()
  })

  it('clears safely when no list was ever set', async () => {
    const agent = createMockAgent()

    const result = await write(new Todos(), agent, [])

    expect(result).toBe('Todo list cleared')
    expect(agent.appState.get('todos')).toBeUndefined()
  })

  it('renders the current list as a reminder', () => {
    const agent = createMockAgent()
    agent.appState.set('todos', sampleTodos())

    expect(renderReminder(new Todos(), agent)).toBe(
      '<system-reminder>\nYour current todo list:\n' +
        '  [completed] Read code\n  [in_progress] Writing tests\n  [pending] Ship\n' +
        'Keep it up to date with todo_write as you work.\n</system-reminder>'
    )
  })

  it('renders no reminder when the list is empty', () => {
    expect(renderReminder(new Todos(), createMockAgent())).toBeUndefined()
  })

  it('scopes the list to the agent, not the plugin', async () => {
    // One instance may be shared across agents, so the list must not live on the plugin.
    const plugin = new Todos()
    const first = createMockAgent()
    const second = createMockAgent()

    await write(plugin, first, sampleTodos())

    expect(first.appState.get('todos')).toEqual(sampleTodos())
    expect(second.appState.get('todos')).toBeUndefined()
    expect(renderReminder(plugin, second)).toBeUndefined()
  })

  it('stores the list under a configurable state key', async () => {
    const agent = createMockAgent()

    await write(new Todos({ stateKey: 'plan' }), agent, sampleTodos())

    expect(agent.appState.get('plan')).toEqual(sampleTodos())
    expect(agent.appState.get('todos')).toBeUndefined()
  })

  it('exposes the todo_write tool', () => {
    expect(new Todos().getTools().map((tool) => tool.name)).toEqual(['todo_write'])
  })

  it('registers the re-surfacing injector as model-input middleware', () => {
    const stages: unknown[] = []
    const stub = { addMiddleware: (stage: unknown) => stages.push(stage) }

    new Todos().initAgent(stub as never)

    expect(stages).toEqual([InvokeModelStage.Input])
  })

  it('takes a configurable plugin name', () => {
    expect(new Todos({ name: 'plan' }).name).toBe('plan')
    expect(new Todos().name).toBe('strands:todos')
  })

  it('validates its input against the model-facing schema', async () => {
    const plugin = new Todos()
    const agent = createMockAgent()
    const badStatus = [{ content: 'Ship', activeForm: 'Shipping', status: 'nope' }] as unknown as TodoItem[]

    await expect(write(plugin, agent, badStatus)).rejects.toThrow(/status/)
    await expect(write(plugin, agent, sampleTodos())).resolves.toContain('2 todos remaining')
  })

  it('rejects a second instance even under a different plugin name', async () => {
    // The registry's duplicate check is on `name`, so renaming must not get a second tool in.
    const plugins = [new Todos({ name: 'first' }), new Todos({ name: 'second', stateKey: 'other' })]
    const agent = new Agent({ model: new MockMessageModel(), printer: false, plugins })

    await expect(agent.initialize()).rejects.toThrow(/todo_write/)
  })

  describe('reminder pacing', () => {
    async function remindedCalls(agent: Agent, model: MockMessageModel, invocations = 1): Promise<boolean[]> {
      const requests: MessageData[][] = []
      const originalStream = model.stream.bind(model)
      vi.spyOn(model, 'stream').mockImplementation(async function* (messages, streamOptions) {
        requests.push(messages.map((message) => message.toJSON()))
        yield* originalStream(messages, streamOptions)
      })

      for (let invocation = 0; invocation < invocations; invocation++) {
        await agent.invoke('go')
      }

      return requests.map(hasReminder)
    }

    it.each([
      {
        name: 'an interval of 1 skips only the call that carries the todo_write result',
        config: { reminderInterval: 1 },
        invocations: [['todo_write', 'work', 'work']],
        expected: [false, false, true, true],
      },
      {
        name: 'a todo_write result and a reminder both restart the count',
        config: { reminderInterval: 2 },
        invocations: [['todo_write', 'work', 'work', 'work', 'work', 'todo_write', 'work', 'work']],
        expected: [false, false, false, true, false, true, false, false, true],
      },
      {
        name: 'the default interval is 10',
        config: {},
        invocations: [['todo_write', ...Array<string>(11).fill('work')]],
        expected: [...Array<boolean>(11).fill(false), true, false],
      },
      {
        name: 'a user turn neither brings the reminder forward nor restarts the count',
        config: { reminderInterval: 3 },
        invocations: [['todo_write', 'work'], [], [], ['work']],
        expected: [false, false, false, false, true, false, false],
      },
    ])(
      'waits reminderInterval model calls after the list was last shown: $name',
      async ({ config, invocations, expected }) => {
        const todos: TodoItem[] = [{ content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' }]
        const model = new MockMessageModel()
        let toolUses = 0
        for (const toolNames of invocations) {
          for (const name of toolNames) {
            const input = name === 'todo_write' ? { todos } : {}
            model.addTurn({ type: 'toolUseBlock', name, toolUseId: `t${toolUses++}`, input })
          }
          model.addTurn({ type: 'textBlock', text: 'Done' })
        }
        const work = createMockTool('work', () => 'ok')
        const agent = new Agent({ model, printer: false, plugins: [new Todos(config)], tools: [work] })

        expect(await remindedCalls(agent, model, invocations.length)).toStrictEqual(expected)
      }
    )

    it('reminds at once when the conversation does not show the list', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'Done' })
      const agent = new Agent({ model, printer: false, plugins: [new Todos()] })
      agent.appState.set('todos', sampleTodos())

      expect(await remindedCalls(agent, model)).toStrictEqual([true])
    })

    it.each([0, -1, 2.5, NaN])('rejects a reminderInterval of %s', (reminderInterval) => {
      expect(() => new Todos({ reminderInterval })).toThrow(`reminderInterval=<${reminderInterval}>`)
    })
  })
})
