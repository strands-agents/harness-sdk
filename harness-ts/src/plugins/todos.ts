/**
 * Todos: a structured task list the agent maintains for multi-step work.
 *
 * A single `todo_write` tool writes the current list to agent state; an internal
 * `ContextInjector` re-surfaces that list to the model before each call so it keeps the plan in
 * view without the list ever entering durable history.
 *
 * Re-surfacing goes through `ContextInjector` rather than editing `agent.messages` from a hook.
 * The list changes on every `todo_write` call, so a durable edit would either stack stale
 * reminders in history or force a remove-then-reappend dance; injection is ephemeral by
 * construction (it augments one model call and never persists), which is exactly what a
 * constantly-changing task list wants. It also happens to be symmetric across both SDKs.
 *
 * The injector fires on `everyTurn`, not `userTurn`: the agent updates the list mid-loop via
 * `todo_write`, so it should see the refreshed list on the next model call within the same
 * invocation, not only at the start of the next user turn.
 */

import { tool, type LocalAgent, type Plugin, type Tool } from '@strands-agents/sdk'
import { ContextInjector, type InjectionContext } from '@strands-agents/sdk/vended-plugins/context-injector'
import { z } from 'zod'

const STATE_KEY = 'todos'
const DEFAULT_NAME = 'strands:todos'

const todoItemSchema = z.object({
  content: z.string().describe('The task, imperative: "Run tests".'),
  activeForm: z.string().describe('Present continuous, shown while in progress: "Running tests".'),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

export type TodoItem = z.infer<typeof todoItemSchema>

function todoLine(todo: TodoItem): string {
  const label = todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content
  return `  [${todo.status}] ${label}`
}

function renderList(todos: TodoItem[]): string {
  return todos.map(todoLine).join('\n')
}

/** Configuration for the {@link Todos} plugin. */
export interface TodosConfig {
  /** Plugin name, for logging and duplicate detection. Defaults to `'strands:todos'`. */
  name?: string
  /** Agent-state key the list is stored under. Defaults to `'todos'`. */
  stateKey?: string
}

/**
 * Gives the agent a `todo_write` tool and keeps the current list in view.
 *
 * The tool persists the list to `agent.appState` under `stateKey`; before each model call the
 * plugin re-surfaces the list as a `<system-reminder>` (ephemeral, never written to durable
 * history). Sharing one instance across agents is safe: state is per-agent.
 */
export class Todos implements Plugin {
  readonly name: string
  private readonly _stateKey: string

  constructor(config: TodosConfig = {}) {
    this.name = config.name ?? DEFAULT_NAME
    this._stateKey = config.stateKey ?? STATE_KEY
  }

  initAgent(agent: LocalAgent): void {
    new ContextInjector({
      name: `${this.name}:injector`,
      trigger: 'everyTurn',
      renderContent: async (context): Promise<string | undefined> => this._renderReminder(context),
    }).initAgent(agent)
  }

  getTools(): Tool[] {
    const stateKey = this._stateKey
    return [
      tool({
        name: 'todo_write',
        description:
          'Create and maintain a structured task list for the current session. Use proactively for ' +
          'multi-step work (roughly 3+ distinct steps). Keep exactly one item in_progress at a time, ' +
          'and update status as you go rather than batching. The current list is re-surfaced to you ' +
          'before each step, so you do not need to restate it. Pass an empty list to clear it when the ' +
          'work is done.',
        inputSchema: z.object({
          todos: z.array(todoItemSchema).describe('The full updated list.'),
        }),
        callback: async (input, context) => {
          if (!context) throw new Error('Tool context is required for todo_write.')
          if (input.todos.length === 0) {
            context.agent.appState.delete(stateKey)
            return 'Todo list cleared'
          }
          context.agent.appState.set(stateKey, input.todos)
          const remaining = input.todos.filter((t) => t.status !== 'completed').length
          return `${remaining} todos remaining\n${renderList(input.todos)}`
        },
      }),
    ]
  }

  private _renderReminder(context: InjectionContext): string | undefined {
    const todos = context.appState.get(this._stateKey) as TodoItem[] | undefined
    if (!todos || todos.length === 0) {
      return undefined
    }
    return (
      '<system-reminder>\nYour current todo list:\n' +
      `${renderList(todos)}\n` +
      'Keep it up to date with todo_write as you work.\n</system-reminder>'
    )
  }
}
