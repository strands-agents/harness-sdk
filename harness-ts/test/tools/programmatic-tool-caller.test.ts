import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import {
  Agent,
  AfterToolCallEvent,
  BeforeToolCallEvent,
  InterventionActions,
  InterventionHandler,
  McpClient,
  TextBlock,
  type ToolContext,
  ToolResultBlock,
  tool,
} from '@strands-agents/sdk'
import { z } from 'zod'

import {
  DEFAULT_PROGRAMMATIC_TOOL_CALLER_DESCRIPTION,
  LIMITS,
  MAX_CONCURRENT_TOOL_CALLS,
  Output,
  SKIP_CONTEXT_OFFLOAD_KEY,
  makeProgrammaticToolCaller,
  programmaticToolCaller,
} from '../../src/tools/programmatic-tool-caller.js'

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

function agentWith(...tools: unknown[]): Agent {
  return new Agent({ tools: [programmaticToolCaller, ...tools] } as never)
}

async function run(agent: Agent, code: string, name = 'programmatic_tool_caller'): Promise<ToolResultBlock> {
  return agent.tool[name]!.invoke({ code }, { recordDirectToolCall: false })
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
    ["print(open('/etc/passwd').read())", 'PermissionError'],
    ['import subprocess', 'ModuleNotFoundError'],
    ['import socket', 'ModuleNotFoundError'],
    ['print(().__class__.__bases__)', 'AttributeError'],
    ["print(eval('1 + 1'))", 'NameError'],
    ['print(__builtins__)', 'NameError'],
  ])('keeps the host unreachable: %s', async (code, expected) => {
    const result = await run(agentWith(calculator), code)
    expect(result.status).toBe('error')
    expect(text(result)).toContain(expected)
  })

  it('bounds a synchronous busy loop via the VM duration limit', async () => {
    const previous = LIMITS.maxDurationSecs
    LIMITS.maxDurationSecs = 0.3
    try {
      const start = Date.now()
      const result = await run(agentWith(calculator), 'while True:\n    pass')
      expect(result.status).toBe('error')
      expect(text(result)).toContain('TimeoutError')
      expect(Date.now() - start).toBeLessThan(5000)
    } finally {
      LIMITS.maxDurationSecs = previous
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
    const agent = new Agent({ tools: [restricted, calculator, boom] } as never)
    expect(text(await run(agent, 'print(await calculator(expression="1 + 1"))', 'run_code'))).toBe('2')
    const result = await run(agent, 'await boom()', 'run_code')
    expect(result.status).toBe('error')
    expect(text(result)).toContain('NameError')
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
    const agent = new Agent({ tools: [programmaticToolCaller, other, calculator] } as never)
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

  it('enforces the timeout', async () => {
    const slow = tool({
      name: 'slow',
      description: 'Block longer than the timeout.',
      inputSchema: z.object({}),
      callback: () => new Promise<string>((resolve) => globalThis.setTimeout(() => resolve('late'), 5000)),
    })
    const quick = makeProgrammaticToolCaller({ name: 'quick', timeoutMs: 300 })
    const result = await run(new Agent({ tools: [quick, slow] } as never), "print('start')\nawait slow()", 'quick')
    expect(result.status).toBe('error')
    expect(text(result)).toBe('Error: start\n\nExecution error: timed out after 0.3 seconds.')
  })

  it('opts inner calls out of context offloading without touching the parent state', async () => {
    const seen: Record<string, unknown>[] = []
    const whoami = tool({
      name: 'whoami',
      description: 'Records the invocation state the inner call ran with.',
      inputSchema: z.object({}),
      callback: (_input, toolContext) => {
        seen.push({ ...toolContext.invocationState })
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
    // The inner call opts out; the parent's own result must still be eligible for offloading.
    expect(seen[0]![SKIP_CONTEXT_OFFLOAD_KEY]).toBe(true)
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

const MCP_SERVER = fileURLToPath(new URL('./programmatic-tool-caller-mcp-server.mjs', import.meta.url))

describe('programmatic_tool_caller over MCP', () => {
  let client: McpClient
  let mcpAgent: Agent

  beforeAll(async () => {
    ;[client] = (await McpClient.loadServers({ ptc: { command: 'node', args: [MCP_SERVER] } })) as [McpClient]
    await client.connect()
    mcpAgent = new Agent({ tools: [programmaticToolCaller, ...(await client.listTools())] } as never)
  })

  afterAll(async () => {
    await client?.disconnect()
  })

  it('calls an MCP tool', async () => {
    expect(text(await run(mcpAgent, 'print(await ptc_echo(text="hello"))'))).toBe('echo:hello')
  })

  it('loops over MCP tool calls', async () => {
    const result = await run(mcpAgent, 'for i in range(3):\n    print(await ptc_add(a=i, b=10))')
    expect(text(result)).toBe('10\n11\n12')
  })

  it('runs MCP tools concurrently', async () => {
    const result = await run(
      mcpAgent,
      'import asyncio\nprint(await asyncio.gather(*[ptc_echo(text=str(i)) for i in range(3)]))'
    )
    expect(text(result)).toBe("['echo:0', 'echo:1', 'echo:2']")
  })

  it('surfaces an MCP tool error as a catchable exception', async () => {
    const result = await run(mcpAgent, "try:\n    await ptc_boom()\nexcept RuntimeError as e:\n    print('caught:', e)")
    expect(result.status).toBe('success')
    expect(text(result)).toContain('mcp tool exploded')
  })

  it('calls a hyphenated MCP tool via its identifier alias', async () => {
    expect(text(await run(mcpAgent, 'print(await ptc_dash(value="x"))'))).toBe('dash:x')
  })

  it('returns only printed output', async () => {
    const result = await run(mcpAgent, 'x = await ptc_echo(text="secret")\nprint("done")')
    expect(text(result)).toBe('done')
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
    const agent = new Agent({ tools: [programmaticToolCaller, shellLike], interventions: [new Deny()] } as never)
    const result = await run(agent, gatedCode)
    expect(result.status).toBe('success')
    expect(text(result)).toContain('DENIED: shell is off')
    expect(calls).toEqual([])
  })

  it('confirm refuses the inner call (no prompt possible), even with onError=proceed', async () => {
    calls.length = 0
    const agent = new Agent({ tools: [programmaticToolCaller, shellLike], interventions: [new Confirm()] } as never)
    const result = await run(agent, gatedCode)
    expect(text(result)).toMatch(/approval/)
    expect(calls).toEqual([])
  })

  it('transform rewrites the inner call input', async () => {
    calls.length = 0
    const agent = new Agent({ tools: [programmaticToolCaller, shellLike], interventions: [new Rewrite()] } as never)
    const result = await run(agent, gatedCode)
    expect(text(result)).toBe('ran:safe')
    expect(calls).toEqual(['safe'])
  })

  it('accepts an approval the handler already collected', async () => {
    calls.length = 0
    const agent = new Agent({ tools: [programmaticToolCaller, shellLike], interventions: [new PreAnswered()] } as never)
    const result = await run(agent, gatedCode)
    expect(text(result)).toBe('ran:rm -rf /')
    expect(calls).toEqual(['rm -rf /'])
  })

  it('fires afterToolCall for a denied inner call with the error result', async () => {
    const seen: string[] = []
    const agent = new Agent({ tools: [programmaticToolCaller, shellLike], interventions: [new Deny()] } as never)
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
    const agent = new Agent({ tools: [programmaticToolCaller, shellLike] } as never)
    delete (agent as unknown as { _hooksRegistry?: unknown })._hooksRegistry
    const result = await run(agent, gatedCode)
    expect(text(result)).toMatch(/refusing to run it ungated/)
    expect(calls).toEqual([])
  })
})
