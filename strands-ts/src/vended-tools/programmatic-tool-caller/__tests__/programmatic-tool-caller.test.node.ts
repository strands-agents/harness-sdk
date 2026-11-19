import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { Agent } from '../../../agent/agent.js'
import { AfterToolCallEvent, BeforeToolCallEvent } from '../../../hooks/events.js'
import { InterventionActions, InterventionHandler } from '../../../interventions/index.js'
import { logger } from '../../../logging/logger.js'
import { tool } from '../../../tools/tool-factory.js'
import { ToolStreamEvent } from '../../../tools/tool.js'
import type { Tool, ToolContext, ToolStreamGenerator } from '../../../tools/tool.js'
import { TextBlock, ToolResultBlock } from '../../../types/messages.js'
import {
  DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION,
  LIMITS,
  MAX_CONCURRENT_TOOL_CALLS,
  Output,
  makeProgrammaticToolCaller,
  programmaticToolCaller,
  streamPrints,
} from '../programmatic-tool-caller.js'
import type { ProgrammaticToolCallerPrintEvent } from '../programmatic-tool-caller.js'

const calculator = tool({
  name: 'calculator',
  description: 'Evaluate a simple arithmetic expression.',
  inputSchema: z.object({ expression: z.string() }),
  callback: (input) => String(Function(`"use strict"; return (${input.expression})`)()),
})

const boom = tool({
  name: 'boom',
  description: 'Always fails.',
  inputSchema: z.object({}),
  callback: () => {
    throw new Error('kaboom')
  },
})

const info = tool({
  name: 'info',
  description: 'Returns structured data.',
  inputSchema: z.object({}),
  callback: () => ({ name: 'demo', tags: ['a', 'b'] }),
})

const fetchUrl = tool({
  name: 'fetch-url',
  description: 'A tool whose name is not a valid identifier.',
  inputSchema: z.object({ value: z.string() }),
  callback: (input) => `dash:${input.value}`,
})

function agentWith(...tools: Tool[]): Agent {
  return agentOf(programmaticToolCaller, ...tools)
}

function agentOf(...tools: Tool[]): Agent {
  return new Agent({ model: new MockMessageModel(), tools })
}

async function run(agent: Agent, code: string, name = 'programmatic_tool_caller'): Promise<ToolResultBlock> {
  return agent.tool[name]!.invoke({ code }, { recordDirectToolCall: false })
}

/** Stream the default caller with a hand-built context, for what a direct tool call cannot set or observe. */
function streamWithContext(agent: Agent, code: string, extra: Partial<ToolContext> = {}): ToolStreamGenerator {
  return programmaticToolCaller.stream({
    toolUse: { toolUseId: 'x', name: 'programmatic_tool_caller', input: { code } },
    agent,
    invocationState: {},
    cancelSignal: new AbortController().signal,
    interrupt: () => {
      throw new Error('no interrupts')
    },
    ...extra,
  })
}

async function runWithContext(agent: Agent, code: string, extra: Partial<ToolContext>): Promise<ToolResultBlock> {
  const generator = streamWithContext(agent, code, extra)
  let next = await generator.next()
  while (!next.done) {
    next = await generator.next()
  }
  return next.value
}

function text(result: ToolResultBlock): string {
  return result.content.map((b) => (b as { text?: string }).text ?? '').join('\n')
}

describe('programmatic_tool_caller', () => {
  it('runs a single tool call', async () => {
    const result = await run(agentWith(calculator), 'print(await calculator(expression="10 * 2"))')
    expect(result.status).toBe('success')
    expect(text(result)).toBe('20')
  })

  it('loops over tool calls', async () => {
    const result = await run(
      agentWith(calculator),
      "for i in range(3):\n    print(await calculator(expression=f'{i} + 10'))"
    )
    expect(text(result)).toBe('10\n11\n12')
  })

  it('runs tool calls concurrently with asyncio.gather', async () => {
    const slow = tool({
      name: 'slow',
      description: 'Sleep, then return the value.',
      inputSchema: z.object({ value: z.number() }),
      callback: async (input) => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 300))
        return String(input.value)
      },
    })
    const start = Date.now()
    const result = await run(
      agentWith(slow),
      'import asyncio\nprint(await asyncio.gather(*[slow(value=i) for i in range(4)]))'
    )
    expect(text(result)).toBe("['0', '1', '2', '3']")
    expect(Date.now() - start).toBeLessThan(1100) // serial would take >= 1200 ms
  })

  it('bounds how many inner calls run at once', async () => {
    let now = 0
    let peak = 0
    const slow = tool({
      name: 'slow',
      description: 'Track how many calls overlap.',
      inputSchema: z.object({ value: z.number() }),
      callback: async (input) => {
        now += 1
        peak = Math.max(peak, now)
        await new Promise((resolve) => globalThis.setTimeout(resolve, 50))
        now -= 1
        return String(input.value)
      },
    })
    const count = MAX_CONCURRENT_TOOL_CALLS * 3
    const result = await run(
      agentWith(slow),
      `import asyncio\nprint(len(await asyncio.gather(*[slow(value=i) for i in range(${count})])))`
    )
    expect(text(result)).toBe(String(count))
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(MAX_CONCURRENT_TOOL_CALLS)
  })

  it('returns only printed output', async () => {
    const result = await run(agentWith(calculator), 'x = await calculator(expression="6 * 7")\nprint("done")')
    expect(text(result)).toBe('done')
  })

  it('reports no output for code that prints nothing', async () => {
    const result = await run(agentWith(calculator), '# nothing here')
    expect(result.status).toBe('success')
    expect(text(result)).toBe('(no output)')
  })

  it('rejects positional arguments with a hint', async () => {
    const result = await run(agentWith(calculator), 'print(await calculator("1 + 1"))')
    expect(result.status).toBe('error')
    expect(text(result)).toContain('keyword arguments only')
    expect(text(result)).toContain('calculator(key=value)')
  })

  it('parses a JSON-text result and leaves other text alone', async () => {
    const jsonText = tool({
      name: 'json_text',
      description: 'Returns JSON as text.',
      inputSchema: z.object({}),
      callback: () => '{"a": [1, 2]}',
    })
    const result = await run(
      agentWith(jsonText, calculator),
      'r = await json_text()\nprint(type(r).__name__, r["a"][1])\ns = await calculator(expression="1 + 1")\nprint(type(s).__name__, s)'
    )
    expect(text(result)).toBe('dict 2\nstr 2')
  })

  it('hands structured results to the code as data', async () => {
    const result = await run(agentWith(info), 'r = await info()\nprint(type(r).__name__, r["tags"][1])')
    expect(text(result)).toBe('dict b')
  })

  it.each([
    ["import os\nprint(os.listdir('/'))", 'PermissionError'],
    ["import os\nprint(os.environ['HOME'])", 'not supported'],
    ["import os\nprint(os.getenv('HOME'))", 'not supported'],
    ["import os\nos.system('id')", 'AttributeError'],
    ["print(open('/etc/passwd').read())", 'PermissionError'],
    ["open('/tmp/programmatic_tool_caller_probe', 'w')", 'PermissionError'],
    ["from pathlib import Path\nprint(Path('/etc/passwd').read_text())", 'PermissionError'],
    ['import subprocess', 'ModuleNotFoundError'],
    ['import socket', 'ModuleNotFoundError'],
    ['print(().__class__.__bases__)', 'AttributeError'],
    ['print(eval("__import__(\'os\')"))', 'NameError'],
    ['exec("import os\\nprint(os.listdir(\'/\'))")', 'PermissionError'],
    ['print(__builtins__)', 'NameError'],
  ])('keeps the host unreachable: %s', async (code, expected) => {
    const result = await run(agentWith(calculator), code)
    expect(result.status).toBe('error')
    expect(text(result)).toContain(expected)
  })

  it('bounds a synchronous busy loop via the VM duration limit', async () => {
    const previous = LIMITS.maxFeedDurationSecs
    LIMITS.maxFeedDurationSecs = 0.3
    try {
      const start = Date.now()
      const result = await run(agentWith(calculator), 'while True:\n    pass')
      expect(result.status).toBe('error')
      expect(text(result)).toContain('TimeoutError')
      expect(Date.now() - start).toBeLessThan(5000)
    } finally {
      LIMITS.maxFeedDurationSecs = previous
    }
  })

  it('enforces the memory limit', async () => {
    const result = await run(agentWith(calculator), "x = 'a' * 10**9\nprint(len(x))")
    expect(result.status).toBe('error')
    expect(text(result)).toContain('MemoryError')
  })

  it('surfaces a tool error as a catchable RuntimeError', async () => {
    const result = await run(
      agentWith(boom),
      "try:\n    await boom()\nexcept RuntimeError as e:\n    print('caught:', e)"
    )
    expect(result.status).toBe('success')
    expect(text(result)).toMatch(/^caught: Tool 'boom' error: .*kaboom/)
  })

  it('keeps output printed before an error', async () => {
    const result = await run(agentWith(calculator), "print('step 1')\nraise ValueError('late')")
    expect(result.status).toBe('error')
    expect(text(result)).toMatch(/^Error: step 1\n\nExecution error:\nTraceback/)
    expect(text(result)).toContain('ValueError: late')
  })

  it('reports a syntax error', async () => {
    const result = await run(agentWith(calculator), 'def broken(:\n    pass')
    expect(result.status).toBe('error')
    expect(text(result)).toContain('Syntax error:')
    expect(text(result)).toContain('SyntaxError')
  })

  it('reports a runtime error with the user line number', async () => {
    const result = await run(agentWith(calculator), "x = 1\ny = 2\nz = {}['missing']")
    expect(result.status).toBe('error')
    expect(text(result)).toContain('line 3')
    expect(text(result)).toContain('KeyError')
  })

  it('does not expose itself to the code', async () => {
    const result = await run(agentWith(calculator), 'programmatic_tool_caller')
    expect(result.status).toBe('error')
    expect(text(result)).toContain('NameError')
  })

  it('filters exposed tools with allowedTools', async () => {
    const restricted = makeProgrammaticToolCaller({ allowedTools: ['calculator'], name: 'run_code' })
    const agent = agentOf(restricted, calculator, boom)
    expect(text(await run(agent, 'print(await calculator(expression="1 + 1"))', 'run_code'))).toBe('2')
    const result = await run(agent, 'await boom()', 'run_code')
    expect(result.status).toBe('error')
    expect(text(result)).toContain('NameError')
  })

  it('ignores and logs allowedTools names that are not registered', async () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {})
    try {
      const caller = makeProgrammaticToolCaller({ allowedTools: ['calculator', 'not_registered'], name: 'run_code' })
      const result = await run(agentOf(caller, calculator), 'print(await calculator(expression="2 + 2"))', 'run_code')
      expect(text(result)).toBe('4')
      expect(debug).toHaveBeenCalledWith(
        'dropped=<not_registered> | allowedTools entries are not registered and were ignored'
      )
    } finally {
      debug.mockRestore()
    }
  })

  it('states the contract in the description', () => {
    for (const phrase of ['await', 'print()', 'RuntimeError', 'keyword arguments', 'fetch_url']) {
      expect(DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION).toContain(phrase)
    }
  })

  it('never exposes another programmatic tool caller', async () => {
    const other = makeProgrammaticToolCaller({
      name: 'run_code',
      allowedTools: ['programmatic_tool_caller', 'calculator'],
    })
    const agent = agentOf(programmaticToolCaller, other, calculator)
    for (const [caller, target] of [
      ['run_code', 'programmatic_tool_caller'],
      ['programmatic_tool_caller', 'run_code'],
    ] as const) {
      const result = await run(agent, `await ${target}(code='print(1)')`, caller)
      expect(result.status).toBe('error')
      expect(text(result)).toContain('NameError')
    }
    expect(text(await run(agent, 'print(await calculator(expression="1 + 1"))', 'run_code'))).toBe('2')
  })

  it('calls a hyphenated tool via its identifier alias', async () => {
    const result = await run(agentWith(fetchUrl), 'print(await fetch_url(value="x"))')
    expect(text(result)).toBe('dash:x')
  })

  it('truncates an error message that is too long', async () => {
    const result = await run(agentWith(calculator), "print('before')\nraise ValueError('x' * 600000)")
    expect(result.status).toBe('error')
    expect(text(result)).toMatch(/^Error: before\n\nExecution error:/)
    expect(text(result)).toMatch(/\[output truncated at \d+ characters\]$/)
    expect(text(result).length).toBeLessThan(200100)
  })

  it('shares the cap between printed output and the error', async () => {
    const result = await run(agentWith(calculator), "print('p' * 210000)\nraise ValueError('e' * 210000)")
    expect(text(result)).toMatch(/^Error: ppp/)
    expect(text(result)).toContain('ValueError: eee')
    expect(text(result).length).toBeLessThan(200100)
  })

  it('truncates a syntax error that is too long', async () => {
    const result = await run(agentWith(calculator), `x = '${'A'.repeat(400000)}' +`)
    expect(text(result)).toMatch(/^Error: Syntax error:/)
    expect(text(result).length).toBeLessThan(200100)
  })

  it('does not buffer an oversized print in full', () => {
    const output = new Output()
    output.write('stdout', 'a'.repeat(200_000 * 5))
    output.write('stdout', 'b'.repeat(100))
    expect(output.chunks.reduce((n, chunk) => n + chunk.length, 0)).toBeLessThanOrEqual(200_001)
    expect(output.text()).toMatch(/\[output truncated at 200000 characters\]$/)
  })

  it('truncates output that is too long', async () => {
    const result = await run(agentWith(calculator), "print('x' * 200500)")
    expect(text(result)).toMatch(/\[output truncated at 200000 characters\]$/)
    expect(text(result).length).toBeLessThan(200100)
  })

  it('streams prints while the code runs', async () => {
    let release: (value: string) => void = () => {}
    const released = new Promise<string>((resolve) => (release = resolve))
    const gate = tool({
      name: 'gate',
      description: 'Block until the test has seen the first print.',
      inputSchema: z.object({}),
      callback: () => released,
    })
    const generator = streamWithContext(agentWith(gate), "print('before')\nawait gate()\nprint('after')")
    const first = await generator.next()
    expect(first.value).toEqual(new ToolStreamEvent({ data: { type: 'print', text: 'before\n' } }))
    release('open')
    const second = await generator.next()
    expect(second.value).toEqual(new ToolStreamEvent({ data: { type: 'print', text: 'after\n' } }))
    const last = await generator.next()
    expect(last.done).toBe(true)
    expect(text(last.value as ToolResultBlock)).toBe('before\nafter')
  })

  it('surfaces prints on the agent stream as tool stream events', async () => {
    const code = "print('one')\nprint(await calculator(expression='1 + 1'))"
    const model = new MockMessageModel()
      .addTurn({ type: 'toolUseBlock', name: 'programmatic_tool_caller', toolUseId: 't1', input: { code } })
      .addTurn({ type: 'textBlock', text: 'done' })
    const agent = new Agent({ model, tools: [programmaticToolCaller, calculator], printer: false })
    const prints: ProgrammaticToolCallerPrintEvent[] = []
    for await (const event of agent.stream('go')) {
      if (event.type === 'toolStreamUpdateEvent') {
        prints.push(event.event.data as ProgrammaticToolCallerPrintEvent)
      }
    }
    expect(new Set(prints.map((print) => print.type))).toEqual(new Set(['print']))
    expect(prints.map((print) => print.text).join('')).toBe('one\n2\n')
  })

  it('streams output printed as the run ends', async () => {
    const output = new Output()
    let finish = (): void => {}
    const stream = streamPrints(output, new Promise<void>((resolve) => (finish = resolve)))
    const first = stream.next()
    output.write('stdout', 'late\n')
    finish()
    expect(await first).toEqual({ done: false, value: { type: 'print', text: 'late\n' } })
    expect(await stream.next()).toEqual({ done: true, value: undefined })
  })

  it('streams output printed while the consumer handles an earlier event', async () => {
    const output = new Output()
    let finish = (): void => {}
    const stream = streamPrints(output, new Promise<void>((resolve) => (finish = resolve)))
    output.write('stdout', 'one\n')
    expect((await stream.next()).value).toEqual({ type: 'print', text: 'one\n' })
    output.write('stdout', 'two\n')
    const second = await Promise.race([stream.next(), new Promise((resolve) => globalThis.setTimeout(resolve, 200))])
    expect(second).toEqual({ done: false, value: { type: 'print', text: 'two\n' } })
    finish()
  })

  it('stops streaming prints at the output cap', () => {
    const output = new Output()
    output.write('stdout', 'x'.repeat(200_000 - 10))
    expect(output.take()).toHaveLength(200_000 - 10)
    output.write('stdout', 'y'.repeat(500))
    output.write('stdout', 'z'.repeat(500))
    expect(output.take()).toBe('y'.repeat(10))
    expect(output.take()).toBe('')
  })

  it('lets the code pass a tool function around as a value', async () => {
    const code =
      'async def twice(fn):\n    return [await fn(expression="1 + 1"), await fn(expression="2 + 2")]\n' +
      'print(await twice(calculator))'
    expect(text(await run(agentWith(calculator), code))).toBe("['2', '4']")
  })

  it('returns at the run timeout while the code is still computing', async () => {
    const quick = makeProgrammaticToolCaller({ name: 'quick', timeout: 300 })
    const previous = LIMITS.maxFeedDurationSecs
    LIMITS.maxFeedDurationSecs = 3
    try {
      const started = Date.now()
      const result = await run(agentOf(quick), "print('start')\nwhile True:\n    pass", 'quick')
      expect(Date.now() - started).toBeLessThan(2000)
      expect(text(result)).toBe('Error: start\n\nExecution error: timed out after 0.3 seconds.')
    } finally {
      LIMITS.maxFeedDurationSecs = previous
    }
  })

  it('returns at once when cancelled while the code is still computing', async () => {
    const controller = new AbortController()
    const previous = LIMITS.maxFeedDurationSecs
    LIMITS.maxFeedDurationSecs = 3
    try {
      const generator = streamWithContext(agentWith(calculator), "print('start')\nwhile True:\n    pass", {
        cancelSignal: controller.signal,
      })
      await generator.next()
      const cancelled = Date.now()
      controller.abort()
      const last = await generator.next()
      expect(Date.now() - cancelled).toBeLessThan(1500)
      expect(text(last.value as ToolResultBlock)).toContain('Execution cancelled.')
    } finally {
      LIMITS.maxFeedDurationSecs = previous
    }
  })

  it('enforces the timeout', async () => {
    const slow = tool({
      name: 'slow',
      description: 'Block longer than the timeout.',
      inputSchema: z.object({}),
      callback: () => new Promise<string>((resolve) => globalThis.setTimeout(() => resolve('late'), 5000)),
    })
    const quick = makeProgrammaticToolCaller({ name: 'quick', timeout: 300 })
    const result = await run(agentOf(quick, slow), "print('start')\nawait slow()", 'quick')
    expect(result.status).toBe('error')
    expect(text(result)).toBe('Error: start\n\nExecution error: timed out after 0.3 seconds.')
  })

  it('defaults to an hour per run and half an hour per tool call', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      await run(agentWith(calculator), "await calculator(expression='1')")
      const delays = timers.mock.calls.map(([, delay]) => delay)
      expect(delays).toContain(3_600_000)
      expect(delays).toContain(1_800_000)
    } finally {
      timers.mockRestore()
    }
  })

  it('times out one tool call with a catchable error and the run continues', async () => {
    let cancelled = false
    const slow = tool({
      name: 'slow',
      description: 'Run longer than the tool timeout.',
      inputSchema: z.object({}),
      callback: (_input, context) =>
        new Promise<string>((resolve) => {
          context?.cancelSignal?.addEventListener('abort', () => (cancelled = true))
          globalThis.setTimeout(() => resolve('late'), 5000)
        }),
    })
    const quick = makeProgrammaticToolCaller({ name: 'quick', toolTimeout: 200 })
    const code =
      "try:\n    await slow()\nexcept RuntimeError as e:\n    print('ERR', e)\n" +
      "print(await calculator(expression='1 + 1'))"
    const started = Date.now()
    const result = await run(agentOf(quick, slow, calculator), code, 'quick')
    expect(Date.now() - started).toBeLessThan(4000)
    expect(result.status).toBe('success')
    expect(text(result)).toBe("ERR Tool 'slow' timed out after 0.2 seconds; it may still be running.\n2")
    expect(cancelled).toBe(true)
  })

  it('does not count time queued for a slot against the tool timeout', async () => {
    const slow = tool({
      name: 'slow',
      description: 'Take a moment.',
      inputSchema: z.object({ value: z.number() }),
      callback: (input) => new Promise<number>((resolve) => globalThis.setTimeout(() => resolve(input.value), 100)),
    })
    // Eight rounds of slots: the later rounds start after the tool timeout has passed since they were queued.
    const count = MAX_CONCURRENT_TOOL_CALLS * 8
    const quick = makeProgrammaticToolCaller({ name: 'quick', toolTimeout: 500 })
    const code = `import asyncio\nprint(len(await asyncio.gather(*[slow(value=i) for i in range(${count})])))`
    expect(text(await run(agentOf(quick, slow), code, 'quick'))).toBe(String(count))
  })

  it('sets no tool timer and leaves a finished tool alone when toolTimeout is Infinity', async () => {
    let aborted = false
    const listen = tool({
      name: 'listen',
      description: 'Watch the cancel signal, then return.',
      inputSchema: z.object({}),
      callback: (_input, context) => {
        context?.cancelSignal?.addEventListener('abort', () => (aborted = true))
        return 'done'
      },
    })
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      const unbounded = makeProgrammaticToolCaller({ name: 'unbounded', toolTimeout: Infinity })
      expect(text(await run(agentOf(unbounded, listen), 'print(await listen())', 'unbounded'))).toBe('done')
      expect(timers.mock.calls.map(([, delay]) => delay)).not.toContain(1_800_000)
      expect(aborted).toBe(false)
    } finally {
      timers.mockRestore()
    }
  })

  it('cancels an in-flight tool call and its timer when the run is cancelled', async () => {
    const controller = new AbortController()
    let cancelled = false
    const hang = tool({
      name: 'hang',
      description: 'Never settles; cancels the run once it is in flight.',
      inputSchema: z.object({}),
      callback: (_input, context) =>
        new Promise<string>(() => {
          context?.cancelSignal?.addEventListener('abort', () => (cancelled = true))
          globalThis.setTimeout(() => controller.abort(), 10)
        }),
    })
    const cleared = vi.spyOn(globalThis, 'clearTimeout')
    const timers = vi.spyOn(globalThis, 'setTimeout')
    try {
      const result = await runWithContext(agentWith(hang), 'await hang()', { cancelSignal: controller.signal })
      expect(text(result)).toContain('Execution cancelled.')
      expect(cancelled).toBe(true)
      const toolTimer = timers.mock.results[timers.mock.calls.findIndex(([, delay]) => delay === 1_800_000)]!.value
      expect(cleared).toHaveBeenCalledWith(toolTimer)
    } finally {
      cleared.mockRestore()
      timers.mockRestore()
    }
  })

  it('starts no tool call after the run ends', async () => {
    const started: number[] = []
    const record = tool({
      name: 'record',
      description: 'Record that the call started.',
      inputSchema: z.object({ value: z.number() }),
      callback: (input) => {
        started.push(input.value)
        return new Promise<number>((resolve) => globalThis.setTimeout(() => resolve(input.value), 200))
      },
    })
    const code =
      'import asyncio\n' +
      'try:\n    await asyncio.gather(boom(), *[record(value=i) for i in range(30)])\n' +
      "except RuntimeError:\n    print('caught')"
    const result = await run(agentWith(boom, record), code)
    expect(text(result)).toBe('caught')
    const startedByTheEnd = started.length
    await new Promise((resolve) => globalThis.setTimeout(resolve, 500))
    expect(startedByTheEnd).toBeLessThan(30)
    expect(started.length).toBe(startedByTheEnd)
  })

  it('runs inner calls and their hooks in the parent request', async () => {
    const seen: unknown[] = []
    const whoami = tool({
      name: 'whoami',
      description: 'Record the request the inner call belongs to.',
      inputSchema: z.object({}),
      callback: (_input, toolContext) => {
        seen.push(toolContext?.invocationContext)
        return 'ok'
      },
    })
    const agent = agentWith(whoami)
    agent.addHook(BeforeToolCallEvent, (event) => void seen.push(event.invocationContext))
    agent.addHook(AfterToolCallEvent, (event) => void seen.push(event.invocationContext))
    const invocationContext = {} as NonNullable<ToolContext['invocationContext']>
    await runWithContext(agent, 'await whoami()', { invocationContext })
    expect(seen).toHaveLength(3)
    for (const context of seen) {
      expect(context).toBe(invocationContext)
    }
  })

  it.each([
    ['timeout', 0],
    ['timeout', -1],
    ['timeout', NaN],
    ['timeout', 2 ** 31],
    ['toolTimeout', 0],
    ['toolTimeout', -1],
    ['toolTimeout', NaN],
    ['toolTimeout', 2 ** 31],
  ])('rejects %s=%s', (option, value) => {
    expect(() => makeProgrammaticToolCaller({ [option]: value })).toThrow(new RegExp(`^${option} must be `))
  })

  it('keeps inner calls from changing the parent state', async () => {
    const whoami = tool({
      name: 'whoami',
      description: 'Writes to the invocation state the inner call ran with.',
      inputSchema: z.object({}),
      callback: (_input, toolContext) => {
        toolContext!.invocationState.writtenByInnerCall = true
        return 'ok'
      },
    })
    const parentState = { principal: 'alice' }
    const context: ToolContext = {
      toolUse: { toolUseId: 'x', name: 'programmatic_tool_caller', input: { code: 'print(await whoami())' } },
      agent: agentWith(whoami),
      invocationState: parentState,
      cancelSignal: new globalThis.AbortController().signal,
      interrupt: () => {
        throw new Error('no interrupts')
      },
    }
    const generator = programmaticToolCaller.stream(context)
    let next = await generator.next()
    while (!next.done) {
      next = await generator.next()
    }
    expect(text(next.value)).toBe('ok')
    expect(parentState).toEqual({ principal: 'alice' })
  })

  it('honors the parent cancel signal', async () => {
    const agent = agentWith(calculator)
    const context: ToolContext = {
      toolUse: {
        toolUseId: 'x',
        name: 'programmatic_tool_caller',
        input: { code: 'await calculator(expression="1")' },
      },
      agent,
      invocationState: {},
      cancelSignal: AbortSignal.abort(),
      interrupt: () => {
        throw new Error('no interrupts')
      },
    }
    const generator = programmaticToolCaller.stream(context)
    let next = await generator.next()
    while (!next.done) {
      next = await generator.next()
    }
    expect(next.value.status).toBe('error')
    expect(text(next.value)).toContain('Execution cancelled.')
  })

  it('cancels an in-flight run and makes no further inner tool calls', async () => {
    const calls: number[] = []
    const bump = tool({
      name: 'bump',
      description: 'Records a call.',
      inputSchema: z.object({}),
      callback: async () => {
        calls.push(Date.now())
        await new Promise((resolve) => globalThis.setTimeout(resolve, 50))
        return 'ok'
      },
    })
    const agent = agentWith(bump)
    const controller = new globalThis.AbortController()
    const context: ToolContext = {
      toolUse: { toolUseId: 'x', name: 'programmatic_tool_caller', input: { code: 'while True:\n    await bump()' } },
      agent,
      invocationState: {},
      cancelSignal: controller.signal,
      interrupt: () => {
        throw new Error('no interrupts')
      },
    }
    globalThis.setTimeout(() => controller.abort(), 300)
    const start = Date.now()
    const generator = programmaticToolCaller.stream(context)
    let next = await generator.next()
    while (!next.done) {
      next = await generator.next()
    }
    const cancelledAt = Date.now()
    expect(cancelledAt - start).toBeLessThan(2000)
    expect(text(next.value)).toContain('Execution cancelled.')
    await new Promise((resolve) => globalThis.setTimeout(resolve, 300))
    expect(calls.filter((t) => t > cancelledAt + 100)).toEqual([])
  })
})

const calls: string[] = []
const shellLike = tool({
  name: 'shell_like',
  description: 'Records that it ran.',
  inputSchema: z.object({ command: z.string() }),
  callback: (input) => {
    calls.push(input.command)
    return `ran:${input.command}`
  },
})

class Deny extends InterventionHandler {
  readonly name = 'deny-shell'
  override beforeToolCall(event: BeforeToolCallEvent) {
    return event.toolUse.name === 'shell_like'
      ? InterventionActions.deny('shell is off')
      : InterventionActions.proceed()
  }
}

class Confirm extends InterventionHandler {
  readonly name = 'ask'
  override readonly onError = 'proceed' as const
  override beforeToolCall(event: BeforeToolCallEvent) {
    return event.toolUse.name === 'shell_like'
      ? InterventionActions.confirm('Run shell?')
      : InterventionActions.proceed()
  }
}

class Rewrite extends InterventionHandler {
  readonly name = 'rewrite'
  override beforeToolCall(event: BeforeToolCallEvent) {
    return InterventionActions.transform(() => {
      event.toolUse.input = { command: 'safe' }
    })
  }
}

class PreAnswered extends InterventionHandler {
  readonly name = 'pre-answered'
  override beforeToolCall(event: BeforeToolCallEvent) {
    return event.toolUse.name === 'shell_like'
      ? InterventionActions.confirm('Run shell?', { response: true })
      : InterventionActions.proceed()
  }
}

const gatedCode =
  "try:\n    print(await shell_like(command='rm -rf /'))\nexcept RuntimeError as e:\n    print('ERR', e)"

describe('inner calls run through the agent hooks', () => {
  it('deny blocks the inner call and the tool never runs', async () => {
    calls.length = 0
    const agent = new Agent({
      model: new MockMessageModel(),
      tools: [programmaticToolCaller, shellLike],
      interventions: [new Deny()],
    })
    const result = await run(agent, gatedCode)
    expect(result.status).toBe('success')
    expect(text(result)).toContain('DENIED: shell is off')
    expect(calls).toEqual([])
  })

  it('confirm refuses the inner call (no prompt possible), even with onError=proceed', async () => {
    calls.length = 0
    const agent = new Agent({
      model: new MockMessageModel(),
      tools: [programmaticToolCaller, shellLike],
      interventions: [new Confirm()],
    })
    const result = await run(agent, gatedCode)
    expect(text(result)).toMatch(/approval/)
    expect(calls).toEqual([])
  })

  it('transform rewrites the inner call input', async () => {
    calls.length = 0
    const agent = new Agent({
      model: new MockMessageModel(),
      tools: [programmaticToolCaller, shellLike],
      interventions: [new Rewrite()],
    })
    const result = await run(agent, gatedCode)
    expect(text(result)).toBe('ran:safe')
    expect(calls).toEqual(['safe'])
  })

  it('accepts an approval the handler already collected', async () => {
    calls.length = 0
    const agent = new Agent({
      model: new MockMessageModel(),
      tools: [programmaticToolCaller, shellLike],
      interventions: [new PreAnswered()],
    })
    const result = await run(agent, gatedCode)
    expect(text(result)).toBe('ran:rm -rf /')
    expect(calls).toEqual(['rm -rf /'])
  })

  it('fires afterToolCall for a denied inner call with the error result', async () => {
    const seen: string[] = []
    const agent = new Agent({
      model: new MockMessageModel(),
      tools: [programmaticToolCaller, shellLike],
      interventions: [new Deny()],
    })
    agent.addHook(AfterToolCallEvent, (e) => void seen.push(`${e.toolUse.name}:${e.result.status}`))
    await run(agent, gatedCode)
    expect(seen).toEqual(['shell_like:error'])
  })

  it('plain before/after hooks observe inner calls and can replace the result', async () => {
    const seen: string[] = []
    const agent = agentWith(shellLike)
    agent.addHook(BeforeToolCallEvent, (e) => void seen.push(`before:${e.toolUse.name}`))
    agent.addHook(AfterToolCallEvent, (e) => {
      seen.push(`after:${e.toolUse.name}`)
      e.result = new ToolResultBlock({
        toolUseId: e.toolUse.toolUseId,
        status: 'success',
        content: [new TextBlock('replaced')],
      })
    })
    const result = await run(agent, "print(await shell_like(command='ls'))")
    expect(text(result)).toBe('replaced')
    expect(seen).toEqual(['before:shell_like', 'after:shell_like'])
  })

  it('refuses inner calls when the agent hooks cannot be reached', async () => {
    calls.length = 0
    const agent = agentOf(programmaticToolCaller, shellLike)
    delete (agent as unknown as { _hooksRegistry?: unknown })._hooksRegistry
    const result = await run(agent, gatedCode)
    expect(text(result)).toMatch(/refusing to run it ungated/)
    expect(calls).toEqual([])
  })
})
