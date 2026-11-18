/**
 * Todos plugin for maintaining a structured task list across a multi-step run.
 *
 * A single `todo_write` tool writes the current list to agent state; an internal
 * {@link ContextInjector} re-renders that list at intervals, so the agent keeps its plan in view
 * without restating it.
 *
 * Re-surfacing goes through `ContextInjector` rather than editing `agent.messages` directly. The
 * list is rewritten on every `todo_write` call, so what matters is that the model sees one current
 * copy rather than a pile of superseded ones. Injection gives that: each rendered list is stored as
 * an `injected` block, and only the latest user message's injected blocks are sent as text — older
 * ones are dropped from the request. The lists stay readable in `agent.messages` for anything
 * inspecting history.
 *
 * The reminder is paced in model calls, not user turns, so a long single invocation gets it
 * mid-loop. The model last saw the list on the call after a `todo_write` or in a reminder; the
 * next reminder waits `reminderInterval` model calls after that, since repeating a list the model
 * has just read only costs tokens.
 */

import { z } from 'zod'
import { tool } from '../../tools/tool-factory.js'
import { ContextInjector } from '../context-injector/plugin.js'
import type { Plugin } from '../../plugins/plugin.js'
import type { LocalAgent } from '../../types/agent.js'
import type { Tool } from '../../tools/tool.js'
import type { InjectionContext } from '../../injection/types.js'
import type { ContentBlockData } from '../../types/messages.js'

const STATE_KEY = 'todos'
const DEFAULT_NAME = 'strands:todos'
const DEFAULT_REMINDER_INTERVAL = 10
const TOOL_NAME = 'todo_write'

const todoItemSchema = z.object({
  content: z.string().describe('The task, imperative: "Run tests".'),
  activeForm: z.string().describe('Present continuous, shown while in progress: "Running tests".'),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

/** One entry in the task list. */
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
  /**
   * Plugin name. It also tags the reminder blocks the plugin injects, and that tag keeps a retry
   * or a restored session from injecting a second copy, so keep it stable. Defaults to
   * `'strands:todos'`.
   */
  name?: string
  /** Agent-state key the list is stored under. Defaults to `'todos'`. */
  stateKey?: string
  /**
   * Re-render the list every this many model calls, counted from the call that last showed it: the
   * one after a `todo_write` call, or a reminder. `1` re-renders it on every call that does not
   * already carry a `todo_write` result. Must be a positive integer. Defaults to `10`.
   */
  reminderInterval?: number
}

/**
 * Gives the agent a `todo_write` tool and keeps the current list in view.
 *
 * The tool persists the list to `agent.appState` under `stateKey`; every `reminderInterval` model
 * calls, counted from the call that last showed the list, the plugin re-renders it as a
 * `<system-reminder>`. Sharing one instance across agents is safe: the list lives in per-agent
 * state, not on the plugin.
 *
 * One agent takes one `Todos`. The tool is always named `todo_write`, so registering a second
 * instance throws no matter how `name` and `stateKey` are set.
 *
 * A reminder changes the tail of the request it is sent with. On a provider without explicit
 * cache points that moves the cached prefix boundary, so a lower `reminderInterval` trades cache
 * hits and tokens for a fresher list.
 *
 * @example
 * ```typescript
 * import { Agent } from '@strands-agents/sdk'
 * import { Todos } from '@strands-agents/sdk/vended-plugins/todos'
 *
 * const agent = new Agent({ model, plugins: [new Todos()] })
 * ```
 */
export class Todos implements Plugin {
  readonly name: string
  private readonly _stateKey: string
  private readonly _reminderInterval: number
  private readonly _injectorName: string

  /** @throws Error if `reminderInterval` is not a positive integer. */
  constructor(config: TodosConfig = {}) {
    const reminderInterval = config.reminderInterval ?? DEFAULT_REMINDER_INTERVAL
    if (!Number.isInteger(reminderInterval) || reminderInterval < 1) {
      throw new Error(`reminderInterval=<${reminderInterval}> | must be a positive integer`)
    }
    this.name = config.name ?? DEFAULT_NAME
    this._stateKey = config.stateKey ?? STATE_KEY
    this._reminderInterval = reminderInterval
    this._injectorName = `${this.name}:injector`
  }

  initAgent(agent: LocalAgent): void {
    new ContextInjector({
      name: this._injectorName,
      trigger: (context): boolean => this._reminderDue(context),
      renderContent: async (context): Promise<string | undefined> => this._renderReminder(context),
    }).initAgent(agent)
  }

  getTools(): Tool[] {
    const stateKey = this._stateKey
    return [
      tool({
        name: TOOL_NAME,
        description:
          'Create and maintain a structured task list for the current session. Use proactively for ' +
          'multi-step work (roughly 3+ distinct steps). Keep exactly one item in_progress at a time, ' +
          'and update status as you go rather than batching. The current list is re-surfaced to you ' +
          'periodically, so you do not need to restate it. Pass an empty list to clear it when the ' +
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
          const remaining = input.todos.filter((todo) => todo.status !== 'completed').length
          return `${remaining} todos remaining\n${renderList(input.todos)}`
        },
      }),
    ]
  }

  /**
   * Whether `reminderInterval` model calls have passed since one last showed the list. Read from
   * the messages rather than a counter, so there is no state to restore, and a list the
   * conversation does not show is re-rendered at once.
   */
  private _reminderDue(context: InjectionContext): boolean {
    let callsSinceShown = 0
    for (const message of [...context.messages].reverse()) {
      if (message.content.some((block) => this._showsList(block))) {
        return callsSinceShown >= this._reminderInterval
      }
      if (message.role === 'assistant') {
        callsSinceShown += 1
      }
    }
    return true
  }

  private _showsList(block: ContentBlockData): boolean {
    if ('injected' in block) {
      return block.injected.source === this._injectorName
    }
    return 'toolUse' in block && block.toolUse.name === TOOL_NAME
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
