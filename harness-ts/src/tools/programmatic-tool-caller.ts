/**
 * `programmatic_tool_caller`: let the agent orchestrate its other tools with Python code.
 *
 * The model calls this tool with a `code` string; the code runs in a Monty sandbox
 * (https://github.com/pydantic/monty) with every other registered tool exposed as an `async`
 * function, so the model can chain, loop over, filter, and parallelize tool calls in a single turn
 * instead of one tool call per model round-trip. Only text the code passes to `print()` is returned
 * to the model; a tool's return value stays in the code's local scope unless printed, which keeps
 * large intermediate payloads out of context.
 *
 * Security posture: Monty is a Python interpreter written in Rust whose VM implements no host
 * operations -- no filesystem, environment, network, FFI, or process access exists in the bytecode,
 * and memory/time/recursion limits are enforced by the VM. The only way out of the sandbox is the
 * tool functions handed in here, so the sandbox reaches exactly what the agent's own tools reach.
 * Under Node the interpreter runs in a separate worker process (native addon) or, where the addon
 * cannot load, in-process as WebAssembly -- the language-level sandbox holds either way, but the
 * in-process build blocks the event loop while the guest computes, so neither the wall-clock timeout
 * nor a cancel can preempt it; guest compute is capped much lower there (`WASM_MAX_DURATION_SECS`).
 * For an OS boundary around the *tools*, run the agent under a Docker/SSH sandbox.
 *
 * Inner tool calls run the way the executor runs a model-issued call (`beforeToolCall` hooks -> the
 * tool -> `afterToolCall` hooks), so `interventions` gate them: a denied call raises a catchable
 * `RuntimeError` in the code, and a call that needs interactive approval is refused the same way,
 * since a direct call cannot prompt. Not reproduced from the executor: `AfterToolCallEvent.retry`,
 * tool middleware/guards, tool spans, and stream-update events.
 */

import {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  type LocalAgent,
  TextBlock,
  Tool,
  type ToolContext,
  ToolResultBlock,
  tool,
} from '@strands-agents/sdk'
import type { JSONValue, ToolUseData } from '@strands-agents/sdk'
import { z } from 'zod'
import { logger } from '../logging.js'

type MontyModule = typeof import('@pydantic/monty')

// Enforced by the Monty VM. Duration counts interpreter time only (the clock pauses while a tool
// call is in flight), so it bounds runaway guest code without penalizing slow tools; the wall clock
// is bounded separately by `timeoutMs`. Suspensions are host round trips: a sequentially awaited
// tool call costs two, a gathered one about one, so this is roughly 500 sequential calls per run.
// Exported for tests, which lower the duration to exercise the limit quickly.
export const LIMITS = { maxDurationSecs: 60, maxMemory: 256 * 1024 * 1024, maxSuspensions: 1_000 }

// Inner tool calls in flight at once per run: `asyncio.gather` over a big list must not fan out
// unbounded against the same agent (a model turn is naturally bounded by its handful of tool_use blocks).
export const MAX_CONCURRENT_TOOL_CALLS = 10

// Every caller made by this module; none is ever exposed to another's code (no nested runs).
const INSTANCES = new WeakSet<Tool>()

// The in-process WebAssembly build cannot be interrupted while the guest computes; keep that bounded.
const WASM_MAX_DURATION_SECS = 5

const USER_CODE_FILENAME = '<programmatic_tool_caller>'

// Cap on the text returned to the model; a runaway `print` should not blow up the context window.
const MAX_OUTPUT_CHARS = 200_000

// `invocationState` key the SDK's `ContextOffloader` honours (`SKIP_CONTEXT_OFFLOAD_KEY`). Inner results
// are consumed by the guest code, not the model, so a preview in place of the data would break it.
export const SKIP_CONTEXT_OFFLOAD_KEY = 'strands:skipContextOffload'

// Wall-clock ceiling for a run, tool calls included, in milliseconds.
const DEFAULT_TIMEOUT_MS = 900_000

const PY_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export const DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION =
  "Execute Python code that orchestrates the agent's other tools, each exposed as an async function " +
  'taking keyword arguments -- always `await` them, e.g. `result = await read(path="/etc/hosts")`. ' +
  'The code runs in an async context, so `await` and `asyncio.gather(...)` work without boilerplate. ' +
  'A tool result that is structured content or JSON text (an object or array) arrives parsed, as a ' +
  'dict/list; anything else arrives as a string. A tool that fails raises RuntimeError, which you can ' +
  'catch. ' +
  "Only text sent to `print()` is returned to you: a tool's return value stays in the code's local " +
  'scope unless you print it. A tool whose name is not a valid Python identifier (for example ' +
  '`fetch-url` or `ns.fetch`) is also available with those characters replaced by underscores ' +
  '(`fetch_url`, `ns_fetch`). The code runs in a sandboxed Python subset: `asyncio`, `json`, `re`, ' +
  '`math`, `datetime`, `collections`, `itertools`, `functools`, `dataclasses`, `typing`, `base64` ' +
  "are importable; filesystem, network, and subprocess access do not exist -- use the agent's tools " +
  'for those. Generators (`yield`), class inheritance, `match`, and `del` are not supported. Use this ' +
  'to chain, loop over, filter, or parallelize tool calls in a single turn instead of one tool call ' +
  'per model round-trip, keeping large intermediate results out of the conversation.'

/** Options for {@link makeProgrammaticToolCaller}. */
export interface MakeProgrammaticToolCallerOptions {
  /**
   * Registry names of the tools to expose to the code. Defaults to every other registered tool.
   * No programmatic tool caller is ever exposed, this one or another instance, even if named here.
   */
  allowedTools?: string[]
  /** Tool name. Defaults to `'programmatic_tool_caller'`. */
  name?: string
  /** Tool description shown to the model. */
  description?: string
  /**
   * Wall-clock ceiling for a run in milliseconds, tool calls included, or `null` to disable it.
   * Defaults to 900 000. Guest compute time is bounded separately by the sandbox.
   */
  timeoutMs?: number | null
}

interface MontyRuntime {
  monty: MontyModule
  inProcess: boolean
}

let montyRuntime: Promise<MontyRuntime> | undefined

/**
 * The Monty runtime: the native addon when it loads, else the bundled WebAssembly build, which runs
 * the interpreter in this process (same language-level sandbox, no crash isolation).
 */
function loadMonty(): Promise<MontyRuntime> {
  montyRuntime ??= import('@pydantic/monty').then(
    (monty) => ({ monty, inProcess: false }),
    async (error: unknown) => {
      logger.warn(
        `programmatic_tool_caller: the native Monty addon did not load (${errorMessage(error)}); ` +
          'falling back to the in-process WebAssembly build.'
      )
      return { monty: (await import('@pydantic/monty/wasm')) as unknown as MontyModule, inProcess: true }
    }
  )
  return montyRuntime
}

/** Raise an error the sandbox sees as a Python exception of the given type. */
function guestError(type: string, message: string, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause })
  error.name = type
  return error
}

function extractText(content: readonly unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    const b = block as { text?: unknown; json?: unknown }
    if (typeof b.text === 'string') {
      parts.push(b.text)
    } else if (b.json !== undefined) {
      parts.push(JSON.stringify(b.json))
    }
  }
  return parts.join('\n')
}

/**
 * The value the code receives for a tool result: structured data (an MCP `structuredContent`, a lone
 * `json` block, or a lone text block that is a JSON object/array) as data so the code can index into
 * it, otherwise the `text` blocks joined.
 */
function unwrapResult(result: ToolResultBlock): unknown {
  const structured = (result as { structuredContent?: unknown }).structuredContent
  if (structured !== undefined && structured !== null) {
    return structured
  }
  const blocks = result.content as readonly { json?: unknown }[]
  if (blocks.length === 1 && blocks[0]!.json !== undefined) {
    return blocks[0]!.json
  }
  const text = extractText(result.content)
  if (blocks.length === 1 && (text.startsWith('{') || text.startsWith('['))) {
    try {
      return JSON.parse(text)
    } catch {
      // not JSON after all; hand back the text
    }
  }
  return text
}

interface HookInvoker {
  invokeCallbacks<T>(event: T): Promise<T>
}

/**
 * The agent's hook registry. The SDK exposes it only for registration (`agent.addHook`), so firing
 * events for inner calls has to reach the private field; when that fails the call is refused rather
 * than run ungated, because the hooks are where `interventions` enforce policy.
 */
function hookInvoker(agent: LocalAgent, toolName: string): HookInvoker {
  const registry = (agent as unknown as { _hooksRegistry?: Partial<HookInvoker> })._hooksRegistry
  if (typeof registry?.invokeCallbacks !== 'function') {
    throw new Error(`Cannot reach the agent's hooks to gate the call to '${toolName}'; refusing to run it ungated.`)
  }
  return registry as HookInvoker
}

/** Fire `AfterToolCallEvent` for an inner call and return the (possibly hook-replaced) result. */
async function afterInnerCall(
  agent: LocalAgent,
  hooks: HookInvoker,
  toolUse: ToolUseData,
  tool: Tool,
  result: ToolResultBlock,
  invocationState: ToolContext['invocationState']
): Promise<ToolResultBlock> {
  const event = new AfterToolCallEvent({ agent, toolUse, tool, result, invocationState })
  return (await hooks.invokeCallbacks(event)).result
}

class ApprovalRequired extends Error {}

/** A fixed pool of slots; `run` waits for one, holds it for the callback, then hands it on. */
class Semaphore {
  private readonly waiters: (() => void)[] = []
  private free: number

  constructor(size: number) {
    this.free = size
  }

  async run<T>(callback: () => Promise<T>): Promise<T> {
    if (this.free === 0) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    } else {
      this.free--
    }
    try {
      return await callback()
    } finally {
      const next = this.waiters.shift()
      if (next) {
        next()
      } else {
        this.free++
      }
    }
  }
}

/**
 * Fire `BeforeToolCallEvent` for an inner call and apply what the hooks decided: a cancel (an
 * intervention's deny) or an unanswered approval request is refused -- as an error result that still
 * goes through `afterToolCall`, as the executor does -- and a hook-substituted tool or transformed
 * input is honored. Approval is refused out of band rather than only by throwing from `interrupt`,
 * since a handler with `onError: 'proceed'` would swallow that throw.
 */
async function gateInnerCall(
  agent: LocalAgent,
  hooks: HookInvoker,
  toolUse: ToolUseData,
  registryTool: Tool,
  invocationState: ToolContext['invocationState'],
  signal: AbortSignal
): Promise<{ tool: Tool; toolUse: ToolUseData }> {
  const event = new BeforeToolCallEvent({ agent, toolUse, tool: registryTool, invocationState })
  let approval: string | undefined
  event.interrupt = <T>(params: { name: string; reason?: string; response?: JSONValue }): T => {
    if (params.response !== undefined) {
      return params.response as T
    }
    approval = params.reason ?? params.name ?? 'no reason given'
    throw new ApprovalRequired()
  }
  try {
    await hooks.invokeCallbacks(event)
  } catch (error) {
    // A handler with `onError: 'throw'` (the HumanInTheLoop default) re-raises the sentinel; any other
    // error is a real hook failure.
    if (!(error instanceof ApprovalRequired)) {
      throw error
    }
  }
  let refusal: string | undefined
  if (approval !== undefined) {
    refusal =
      `Tool '${toolUse.name}' needs approval (${approval}), which programmatic_tool_caller cannot prompt for; ` +
      'call it as a normal tool call instead.'
  } else if (signal.aborted) {
    // The hooks may have taken long enough (an approval classifier, say) for the run to end.
    refusal = 'programmatic_tool_caller was cancelled; no further tool calls are made.'
  } else if (event.cancel) {
    refusal = typeof event.cancel === 'string' ? event.cancel : `Tool '${toolUse.name}' was cancelled by a hook.`
  }
  if (refusal !== undefined) {
    const refused = new ToolResultBlock({
      toolUseId: toolUse.toolUseId,
      status: 'error',
      content: [new TextBlock(refusal)],
    })
    const result = await afterInnerCall(agent, hooks, toolUse, registryTool, refused, invocationState)
    throw new Error(extractText(result.content) || refusal)
  }
  // Hooks may rename in place (then `event.toolUse` is this same object), so compare against the tool
  // the name was resolved from.
  const tool =
    event.selectedTool ??
    (event.toolUse.name !== registryTool.name ? agent.toolRegistry.resolve(event.toolUse.name) : registryTool)
  return { tool, toolUse: { ...event.toolUse, toolUseId: toolUse.toolUseId } }
}

/**
 * Wrap a tool as a host function for the sandbox. Python keyword arguments arrive as one object,
 * which is the tool's input; positional arguments are rejected with a hint. Runs the call the way the
 * executor would (`beforeToolCall` hooks -> the tool -> `afterToolCall` hooks); an error result is
 * raised as a `RuntimeError` in the code.
 */
function makeToolFunction(
  agent: LocalAgent,
  toolName: string,
  parent: ToolContext,
  signal: AbortSignal,
  slots: Semaphore
): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]): Promise<unknown> => {
    const [input = {}] = args
    if (args.length > 1 || typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw guestError('TypeError', `${toolName}() takes keyword arguments only, e.g. ${toolName}(key=value)`)
    }
    return slots.run(() => callTool(agent, toolName, parent, signal, input as JSONValue))
  }
}

async function callTool(
  agent: LocalAgent,
  toolName: string,
  parent: ToolContext,
  signal: AbortSignal,
  input: JSONValue
): Promise<unknown> {
  // A cancelled run makes no further real tool calls (writes, shell, MCP) behind the model's back.
  if (signal.aborted) {
    throw guestError('RuntimeError', 'programmatic_tool_caller was cancelled; no further tool calls are made.')
  }
  const invocationState = { ...parent.invocationState, [SKIP_CONTEXT_OFFLOAD_KEY]: true }
  let result: ToolResultBlock
  try {
    const hooks = hookInvoker(agent, toolName)
    const registryTool = agent.toolRegistry.resolve(toolName)
    const requested: ToolUseData = {
      toolUseId: `ptc_${globalThis.crypto.randomUUID()}`,
      name: registryTool.name,
      input,
    }
    const { tool, toolUse } = await gateInnerCall(agent, hooks, requested, registryTool, invocationState, signal)
    const toolContext: ToolContext = {
      toolUse,
      agent,
      invocationState,
      cancelSignal: signal,
      interrupt: () => {
        throw new Error('Interrupts are not supported from programmatic_tool_caller.')
      },
    }
    const generator = tool.stream(toolContext)
    let next = await generator.next()
    while (!next.done) {
      next = await generator.next()
    }
    result = await afterInnerCall(agent, hooks, toolUse, tool, next.value, invocationState)
  } catch (error) {
    throw guestError('RuntimeError', `Failed to execute tool '${toolName}': ${errorMessage(error)}`, error)
  }
  if (result.status === 'error') {
    throw guestError('RuntimeError', `Tool '${toolName}' error: ${extractText(result.content) || 'Unknown error'}`)
  }
  return unwrapResult(result)
}

/**
 * The set of tools to expose to the code: every registered tool that is not a programmatic tool caller
 * (not this one, not another instance -- two callers exposing each other would recurse).
 */
function resolveAvailableTools(agent: LocalAgent, allowedTools: string[] | undefined): string[] {
  const others = agent.toolRegistry
    .list()
    .filter((t) => !INSTANCES.has(t))
    .map((t) => t.name)
  return allowedTools ? others.filter((n) => allowedTools.includes(n)) : others
}

/**
 * The host functions handed to the sandbox: one per tool, plus an alias for each tool whose name is
 * not a valid identifier (MCP servers commonly use `-` or `.`): every non-identifier character
 * becomes `_`. An alias that would shadow a real tool name or another tool's alias is dropped rather
 * than guessed. The functions share one pool of concurrency slots per run.
 */
function buildExternalLookup(
  available: string[],
  agent: LocalAgent,
  parent: ToolContext,
  signal: AbortSignal
): Record<string, unknown> {
  const slots = new Semaphore(MAX_CONCURRENT_TOOL_CALLS)
  const lookup: Record<string, unknown> = {}
  for (const name of available) {
    lookup[name] = makeToolFunction(agent, name, parent, signal, slots)
  }

  const aliases = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const name of [...available].sort()) {
    if (PY_IDENTIFIER.test(name)) {
      continue
    }
    const alias = name.replace(/[^A-Za-z0-9_]/g, '_')
    if (!PY_IDENTIFIER.test(alias) || available.includes(alias)) {
      continue
    }
    if (aliases.has(alias)) {
      ambiguous.add(alias)
      continue
    }
    aliases.set(alias, name)
  }
  for (const alias of ambiguous) {
    aliases.delete(alias)
    logger.warn(`programmatic_tool_caller: multiple tools normalize to '${alias}', no alias injected`)
  }
  for (const [alias, name] of aliases) {
    lookup[alias] = lookup[name]
  }

  return lookup
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Collects the code's `print()` output, capped at `MAX_OUTPUT_CHARS`. Exported for tests. */
export class Output {
  readonly chunks: string[] = []
  private size = 0

  write(_stream: 'stdout' | 'stderr', text: string): void {
    // Buffer one char past the cap so `cap` still sees that the output overflowed.
    const room = MAX_OUTPUT_CHARS + 1 - this.size
    if (room > 0) {
      const kept = text.slice(0, room)
      this.chunks.push(kept)
      this.size += kept.length
    }
  }

  text(): string {
    return cap(this.chunks.join(''))
  }

  /**
   * The error message, preceded by whatever the code printed before failing. Both share the cap (a
   * traceback can carry a huge exception message): the error keeps at least half, the output the rest.
   */
  withError(message: string): string {
    const raw = this.chunks.join('')
    const messageLimit = Math.max(MAX_OUTPUT_CHARS - raw.length, MAX_OUTPUT_CHARS / 2)
    const capped = cap(message, messageLimit)
    const printed = cap(raw, MAX_OUTPUT_CHARS - Math.min(capped.length, messageLimit))
    return printed ? `${printed}\n\n${capped}` : capped
  }
}

function cap(raw: string, limit = MAX_OUTPUT_CHARS): string {
  if (raw.length <= limit) {
    return raw.trim()
  }
  return `${raw.slice(0, limit).trim()}\n[output truncated at ${limit} characters]`
}

/**
 * Await `run` until it settles, `timeoutMs` elapses, or `cancelSignal` fires. Rejects with `'timeout'`
 * or `'cancel'` on the latter two; the caller tears the sandbox down, which is what stops the code.
 */
function withDeadline<T>(run: Promise<T>, timeoutMs: number | null, cancelSignal: AbortSignal | undefined): Promise<T> {
  const cleanup = new globalThis.AbortController()
  return new Promise<T>((resolve, reject) => {
    if (cancelSignal?.aborted) {
      reject(new Error('cancel'))
      return
    }
    cancelSignal?.addEventListener('abort', () => reject(new Error('cancel')), { once: true, signal: cleanup.signal })
    if (timeoutMs !== null) {
      const timer = globalThis.setTimeout(() => reject(new Error('timeout')), timeoutMs)
      cleanup.signal.addEventListener('abort', () => globalThis.clearTimeout(timer), { once: true })
    }
    run.then(resolve, reject)
  }).finally(() => cleanup.abort())
}

/**
 * Create a programmatic-tool-caller tool. The returned tool executes agent-authored Python in a Monty
 * sandbox in which the agent's other tools are exposed as `async` functions. Only `print()` output is
 * returned.
 */
export function makeProgrammaticToolCaller(options: MakeProgrammaticToolCallerOptions = {}): Tool {
  const {
    allowedTools,
    name = 'programmatic_tool_caller',
    description = DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options

  const caller = tool({
    name,
    description,
    inputSchema: z.object({
      code: z.string().describe('Python code to execute. Use `await tool_name(...)` to call tools.'),
    }),
    callback: async (input, context): Promise<string> => {
      if (!context?.agent) {
        throw new Error('No agent available. The programmatic tool caller requires an agent context.')
      }
      const agent = context.agent
      const available = resolveAvailableTools(agent, allowedTools)

      // Inner tool calls stop on a timeout or a parent cancel: forward the parent cancel into this one
      // controller (rather than AbortSignal.any, which needs Node >= 20.3).
      const controller = new globalThis.AbortController()
      const forwardCancel = (): void => controller.abort()
      if (context.cancelSignal?.aborted) {
        controller.abort()
      } else {
        context.cancelSignal?.addEventListener('abort', forwardCancel, { once: true })
      }
      try {
        const externalLookup = buildExternalLookup(available, agent, context, controller.signal)
        const output = new Output()

        const { monty, inProcess } = await loadMonty()
        const { Monty, MontyError, MontyRuntimeError, MontySyntaxError } = monty
        const limits = inProcess
          ? { ...LIMITS, maxDurationSecs: Math.min(LIMITS.maxDurationSecs, WASM_MAX_DURATION_SECS) }
          : LIMITS
        const pool = await Monty.create()
        try {
          const session = await pool.checkout({ scriptName: USER_CODE_FILENAME, limits })
          try {
            const run = session.feedRun(input.code, {
              externalLookup,
              printCallback: (stream, text) => output.write(stream, text),
            })
            // On timeout/cancel the run is abandoned and its session closed; swallow the late rejection.
            run.catch(() => {})
            await withDeadline(run, timeoutMs, context.cancelSignal)
          } catch (error) {
            controller.abort()
            if (error instanceof Error && error.message === 'cancel') {
              throw new Error('Execution cancelled.', { cause: error })
            }
            if (error instanceof Error && error.message === 'timeout' && timeoutMs !== null) {
              throw new Error(output.withError(`Execution error: timed out after ${timeoutMs / 1000} seconds.`), {
                cause: error,
              })
            }
            if (error instanceof MontySyntaxError) {
              throw new Error(cap(`Syntax error:\n${error.display('traceback')}`), { cause: error })
            }
            if (error instanceof MontyRuntimeError) {
              throw new Error(output.withError(`Execution error:\n${error.display('traceback')}`), { cause: error })
            }
            if (error instanceof MontyError) {
              throw new Error(output.withError(`Execution error: ${error.message}`), { cause: error })
            }
            throw error
          } finally {
            await session.close()
          }
        } finally {
          await pool.close()
        }

        return output.text() || '(no output)'
      } finally {
        context.cancelSignal?.removeEventListener('abort', forwardCancel)
      }
    },
  })
  INSTANCES.add(caller)
  return caller
}

/** Default programmatic tool caller. Exposes every other registered tool. */
export const programmaticToolCaller = makeProgrammaticToolCaller()
