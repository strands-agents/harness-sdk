import { describe, expect, it } from 'vitest'
import type { Agent, Plugin, ToolContext } from '@strands-agents/sdk'
import type { InjectionContext } from '@strands-agents/sdk/vended-plugins/context-injector'

import type { LocalAgent } from '@strands-agents/sdk'

import { createHarness } from '../../src/agent.js'
import { Todos, type TodoItem } from '../../src/plugins/todos.js'

function plugins(agent: Agent): Plugin[] {
  const registry = (agent as unknown as { _pluginRegistry: { _plugins: Map<string, Plugin>; _pending?: Plugin[] } })
    ._pluginRegistry
  return [...registry._plugins.values(), ...(registry._pending ?? [])]
}

function sampleTodos(): TodoItem[] {
  return [
    { content: 'Read code', activeForm: 'Reading code', status: 'completed' },
    { content: 'Write tests', activeForm: 'Writing tests', status: 'in_progress' },
    { content: 'Ship', activeForm: 'Shipping', status: 'pending' },
  ]
}

function injectionContext(agent: Agent): InjectionContext {
  return { agent, appState: agent.appState, messages: [] } as unknown as InjectionContext
}

describe('Todos', () => {
  it('persists the list to app state and reports remaining count', async () => {
    const agent = await createHarness()
    const [todoWrite] = new Todos().getTools()
    const result = (await todoWrite.invoke({ todos: sampleTodos() }, { agent } as unknown as ToolContext)) as string
    expect(agent.appState.get('todos')).toEqual(sampleTodos())
    expect(result).toContain('2 todos remaining')
    expect(result).toContain('[in_progress] Writing tests')
  })

  it('clears app state when given an empty list', async () => {
    const agent = await createHarness()
    const [todoWrite] = new Todos().getTools()
    await todoWrite.invoke({ todos: sampleTodos() }, { agent } as unknown as ToolContext)
    const result = (await todoWrite.invoke({ todos: [] }, { agent } as unknown as ToolContext)) as string
    expect(result).toBe('Todo list cleared')
    expect(agent.appState.get('todos')).toBeUndefined()
  })

  it('clears safely when no list was ever set', async () => {
    const agent = await createHarness()
    const [todoWrite] = new Todos().getTools()
    const result = (await todoWrite.invoke({ todos: [] }, { agent } as unknown as ToolContext)) as string
    expect(result).toBe('Todo list cleared')
    expect(agent.appState.get('todos')).toBeUndefined()
  })

  it('re-surfaces the list as a reminder when todos are present', async () => {
    const agent = await createHarness()
    agent.appState.set('todos', sampleTodos())
    const reminder = (
      new Todos() as unknown as { _renderReminder(c: InjectionContext): string | undefined }
    )._renderReminder(injectionContext(agent))
    expect(reminder).toContain('<system-reminder>')
    expect(reminder).toContain('[completed] Read code')
    expect(reminder).toContain('[in_progress] Writing tests')
  })

  it('renders no reminder when there are no todos', async () => {
    const agent = await createHarness()
    const reminder = (
      new Todos() as unknown as { _renderReminder(c: InjectionContext): string | undefined }
    )._renderReminder(injectionContext(agent))
    expect(reminder).toBeUndefined()
  })

  it('is enabled by default and contributes the todo_write tool', async () => {
    const agent = await createHarness()
    const todos = plugins(agent).filter((p): p is Todos => p instanceof Todos)
    expect(todos).toHaveLength(1)
    expect(todos[0]!.getTools().map((t) => t.name)).toContain('todo_write')
  })

  it('is disabled when not selected', async () => {
    const agent = await createHarness({ builtinPlugins: [] })
    expect(plugins(agent).some((p) => p instanceof Todos)).toBe(false)
  })

  it('throws on an unknown built-in plugin name', async () => {
    await expect(createHarness({ builtinPlugins: ['nope'] as never })).rejects.toThrow('Unknown built-in plugin')
  })

  it('registers a context injector on initAgent', () => {
    const added: unknown[] = []
    const stub = { addMiddleware: (_stage: unknown, handler: unknown) => added.push(handler) }
    new Todos().initAgent(stub as unknown as LocalAgent)
    expect(added).toHaveLength(1)
  })
})
