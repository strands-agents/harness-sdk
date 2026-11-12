import { describe, expect, it, vi } from 'vitest'
import { Todos } from '../plugin.js'
import type { TodoItem } from '../plugin.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { InvokeModelStage } from '../../../middleware/index.js'
import { Agent } from '../../../agent/agent.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
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

    await expect(write(plugin, agent, badStatus)).rejects.toThrow()
    await expect(write(plugin, agent, sampleTodos())).resolves.toContain('2 todos remaining')
  })

  it('re-surfaces the list on the next model call in the same invocation', async () => {
    // The everyTurn trigger exists for this: under userTurn the mid-loop call carries no reminder.
    const todos: TodoItem[] = [{ content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' }]
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'todo_write', toolUseId: 't1', input: { todos } })
      .addTurn({ type: 'textBlock', text: 'Done' })
    const agent = new Agent({ model, printer: false, plugins: [new Todos()] })
    const requests: MessageData[][] = []
    const originalStream = model.stream.bind(model)
    vi.spyOn(model, 'stream').mockImplementation(async function* (messages, streamOptions) {
      requests.push(messages.map((message) => message.toJSON()))
      yield* originalStream(messages, streamOptions)
    })

    await agent.invoke('go')

    expect(requests.map(hasReminder)).toStrictEqual([false, true])
  })
})
