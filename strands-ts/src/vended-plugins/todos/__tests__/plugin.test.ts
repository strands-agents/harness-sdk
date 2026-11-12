import { describe, expect, it } from 'vitest'
import { Todos } from '../plugin.js'
import type { TodoItem } from '../plugin.js'
import { createMockAgent } from '../../../__fixtures__/agent-helpers.js'
import { InvokeModelStage } from '../../../middleware/index.js'
import type { MockAgent } from '../../../__fixtures__/agent-helpers.js'
import type { InjectionContext } from '../../../injection/types.js'
import type { InvokableTool, ToolContext } from '../../../tools/tool.js'

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

  it('renders the active form only while an item is in progress', async () => {
    // The active form is what the list is for: it says what is happening right now.
    const result = await write(new Todos(), createMockAgent(), sampleTodos())

    expect(result).toContain('[in_progress] Writing tests')
    expect(result).toContain('[completed] Read code')
    expect(result).not.toContain('Reading code')
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
})
