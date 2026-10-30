import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  AfterToolsEvent,
  BeforeToolCallEvent,
  Model,
  Sandbox,
  SandboxTimeoutError,
  type Agent,
  type BaseModelConfig,
  type ExecutionResult,
  type FileInfo,
  type Message,
  type ModelStreamEvent,
  type Plugin,
  type StreamChunk,
} from '@strands-agents/sdk'
import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal'

import { createHarness, type HarnessAgentOptions } from '../../src/agent.js'
import { configureLogging } from '../../src/logging.js'
import { Verification, detectChecks } from '../../src/plugins/verification.js'

type ToolCall = [name: string, input: Record<string, unknown>]
/** A text turn that ends with `reason` instead of `endTurn`. */
type Stop = { text: string; reason: 'stopSequence' | 'maxTokens' }
type Turn = string | Stop | ToolCall[]

/** Replays assistant turns in order: a text reply, a list of tool calls, or a {@link Stop}. */
class ScriptedModel extends Model<BaseModelConfig> {
  readonly prompts: string[] = []
  private readonly _turns: Turn[]

  constructor(turns: Turn[]) {
    super()
    this._turns = [...turns]
  }

  updateConfig(): void {}

  getConfig(): BaseModelConfig {
    return { modelId: 'scripted' }
  }

  async *stream(messages: Message[]): AsyncGenerator<ModelStreamEvent> {
    for (const block of messages.at(-1)?.content ?? []) {
      if (block.type === 'textBlock') this.prompts.push(block.text)
    }
    const turn = this._turns.shift()
    if (turn === undefined) throw new Error('All turns have been consumed')
    yield { type: 'modelMessageStartEvent', role: 'assistant' }
    if (!Array.isArray(turn)) {
      const { text, reason } = typeof turn === 'string' ? { text: turn, reason: 'endTurn' as const } : turn
      yield { type: 'modelContentBlockStartEvent' }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text } }
      yield { type: 'modelContentBlockStopEvent' }
      yield { type: 'modelMessageStopEvent', stopReason: reason }
      return
    }
    for (const [index, [name, input]] of turn.entries()) {
      const toolUseId = `t${this._turns.length}${index}`
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name, toolUseId } }
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(input) } }
      yield { type: 'modelContentBlockStopEvent' }
    }
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' }
  }
}

/** Host-filesystem sandbox for the file tools; `execute` is what each test overrides. */
class FileSandbox extends Sandbox {
  // eslint-disable-next-line require-yield
  async *executeStreaming(): AsyncIterable<StreamChunk | ExecutionResult> {
    throw new Error('not used')
  }

  // eslint-disable-next-line require-yield
  async *executeCodeStreaming(): AsyncIterable<StreamChunk | ExecutionResult> {
    throw new Error('not used')
  }

  async readFile(path: string): Promise<Uint8Array> {
    return readFile(path)
  }

  async writeFile(path: string, content: Uint8Array): Promise<void> {
    await writeFile(path, content)
  }

  async removeFile(path: string): Promise<void> {
    await rm(path)
  }

  async listFiles(path: string): Promise<FileInfo[]> {
    return (await readdir(path, { withFileTypes: true })).map((e) => ({ name: e.name, isDir: e.isDirectory() }))
  }
}

/** Sandbox whose `execute` returns scripted exit codes and records the commands it ran. */
class ScriptedSandbox extends FileSandbox {
  readonly commands: string[] = []

  constructor(
    private readonly _exitCodes: number[],
    private readonly _stdout: (command: string) => string = (command) => `ran ${command}`
  ) {
    super()
  }

  override async execute(command: string): Promise<ExecutionResult> {
    this.commands.push(command)
    const exitCode = this._exitCodes.shift()
    if (exitCode === undefined) throw new Error(`unexpected check: ${command}`)
    return {
      type: 'executionResult',
      exitCode,
      stdout: this._stdout(command),
      stderr: exitCode === 0 ? '' : '1 failed',
      outputFiles: [],
    }
  }
}

let dir: string
let cwd: string

beforeEach(() => {
  cwd = process.cwd()
  dir = mkdtempSync(join(tmpdir(), 'harness-verify-'))
  process.chdir(dir)
})

afterEach(() => {
  process.chdir(cwd)
  rmSync(dir, { recursive: true, force: true })
})

function write(name = 'out.txt'): ToolCall[] {
  return [['write', { path: join(dir, name), content: 'x' }]]
}

async function harness(model: Model, options: HarnessAgentOptions = {}): Promise<Agent> {
  return createHarness({
    model,
    builtinTools: ['read', 'write'],
    builtinPlugins: [],
    session: false,
    memory: false,
    skills: false,
    contextManager: false,
    caching: false,
    printer: false,
    ...options,
  })
}

function plugins(agent: Agent): Plugin[] {
  const registry = (agent as unknown as { _pluginRegistry: { _plugins: Map<string, Plugin>; _pending?: Plugin[] } })
    ._pluginRegistry
  return [...registry._plugins.values(), ...(registry._pending ?? [])]
}

function verificationOf(agent: Agent): Verification | undefined {
  return plugins(agent).find((p): p is Verification => p instanceof Verification)
}

function outcome(agent: Agent): [boolean, string, boolean[]] | undefined {
  const result = verificationOf(agent)!.lastResult(agent)
  return result && [result.passed, result.stopReason, result.attempts.map((a) => a.passed)]
}

function read(): ToolCall[] {
  return [['read', { path: join(dir, 'out.txt') }]]
}

function gateRead(agent: Agent): void {
  agent.addHook(BeforeToolCallEvent, (event) => {
    if (event.toolUse.name === 'read') event.interrupt({ name: 'approve-read', reason: 'read?' })
  })
}

const SO = 'strands_structured_output'
const schema = z.object({ summary: z.string() })

describe('verify', () => {
  it('is off by default', async () => {
    expect(verificationOf(await harness(new ScriptedModel([])))).toBeUndefined()
  })

  it('returns the answer and records state when the checks pass', async () => {
    const sandbox = new ScriptedSandbox([0, 0])
    const agent = await harness(new ScriptedModel([write(), 'Done.']), { sandbox, verify: ['lint', 'test'] })

    const result = await agent.invoke('make it')

    expect(result.toString().trim()).toBe('Done.')
    expect(sandbox.commands).toEqual(['lint', 'test'])
    expect(agent.appState.get('verification')).toEqual({
      status: 'passed',
      attempts: 1,
      checks: [
        { command: 'lint', exitCode: 0 },
        { command: 'test', exitCode: 0 },
      ],
    })
  })

  it('feeds a failing check back until it passes', async () => {
    const model = new ScriptedModel([write(), 'Done.', write(), 'Fixed.'])
    const agent = await harness(model, { sandbox: new ScriptedSandbox([1, 0]), verify: 'npm test' })

    const result = await agent.invoke('make it')

    expect(result.toString().trim()).toBe('Fixed.')
    const feedback = model.prompts.find((p) => p.includes('<verification>'))!
    expect(feedback).toContain('attempt 1 of 3')
    expect(feedback).toContain('$ npm test\nexit code 1')
    expect(feedback).toContain('1 failed')
    expect(agent.appState.get('verification')).toMatchObject({ status: 'passed', attempts: 2 })
  })

  it('returns the last answer unverified once the attempts are spent', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    try {
      const model = new ScriptedModel([write(), 'Done.', write(), 'Done again.'])
      const sandbox = new ScriptedSandbox([1, 1])
      const agent = await harness(model, { sandbox, verify: { commands: ['npm test'], maxAttempts: 2 } })

      const result = await agent.invoke('make it')

      // GoalLoop stops after maxAttempts failed checks; there is no extra report turn.
      expect(result.toString().trim()).toBe('Done again.')
      expect(sandbox.commands).toEqual(['npm test', 'npm test'])
      expect(agent.appState.get('verification')).toEqual({
        status: 'failed',
        attempts: 2,
        checks: [{ command: 'npm test', exitCode: 1 }],
      })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('returning the answer unverified'))
    } finally {
      configureLogging({ debug: () => {}, info: () => {}, warn: console.warn, error: console.error })
    }
  })

  it('still runs the checks when a retry changes nothing', async () => {
    // The retry changes nothing; its "done" must still be checked against the failing workspace.
    const sandbox = new ScriptedSandbox([1, 1])
    const agent = await harness(new ScriptedModel([write(), 'Done.', 'Fixed, trust me.']), {
      sandbox,
      verify: { commands: ['t'], maxAttempts: 2 },
    })

    await agent.invoke('make it')

    expect(sandbox.commands).toEqual(['t', 't'])
    expect(agent.appState.get('verification')).toMatchObject({ status: 'failed' })
  })

  it('is a GoalLoop', async () => {
    const model = new ScriptedModel([write(), 'Done.', write(), 'Done again.', write(), 'Fixed.'])
    const agent = await harness(model, {
      sandbox: new ScriptedSandbox([1, 1, 0]),
      verify: { commands: ['t'], maxAttempts: 2 },
    })
    const plugin = verificationOf(agent)!

    expect(plugin).toBeInstanceOf(GoalLoop)
    await agent.invoke('make it')
    expect(plugin.lastResult(agent)?.stopReason).toBe('maxAttempts')
    await agent.invoke('try again') // a new request starts a new GoalLoop run
    expect(plugin.lastResult(agent)).toMatchObject({
      passed: true,
      stopReason: 'satisfied',
      attempts: [{ attempt: 1 }],
    })
  })

  it('runs no checks for a read-only invocation', async () => {
    const sandbox = new ScriptedSandbox([])
    const model = new ScriptedModel([[['read', { path: join(dir, 'missing.txt') }]], 'It is empty.'])
    const agent = await harness(model, { sandbox, verify: 'npm test' })

    await agent.invoke('what is in it?')

    expect(sandbox.commands).toEqual([])
    expect(agent.appState.get('verification')).toBeUndefined()
  })

  it('starts a fresh run for each invocation', async () => {
    const sandbox = new ScriptedSandbox([0])
    const agent = await harness(new ScriptedModel([write(), 'Done.', 'Just answering.']), {
      sandbox,
      verify: 'npm test',
    })

    await agent.invoke('make it')
    await agent.invoke('a question')

    expect(sandbox.commands).toEqual(['npm test'])
  })

  it('verifies changes made before an interrupt once the agent finishes', async () => {
    const sandbox = new ScriptedSandbox([0])
    const model = new ScriptedModel([write(), [['read', { path: join(dir, 'out.txt') }]], 'Done.'])
    const agent = await harness(model, { sandbox, verify: 'npm test' })
    agent.addHook(BeforeToolCallEvent, (event) => {
      if (event.toolUse.name === 'read') event.interrupt({ name: 'approve-read', reason: 'read?' })
    })

    const first = await agent.invoke('make it')
    expect(first.stopReason).toBe('interrupt')
    expect(sandbox.commands).toEqual([])

    // Only the read-only `read` runs after the interrupt; the checks still run for the earlier write.
    await agent.invoke([{ interruptResponse: { interruptId: first.interrupts[0]!.id, response: 'yes' } }])
    expect(sandbox.commands).toEqual(['npm test'])
    expect(agent.appState.get('verification')).toMatchObject({ status: 'passed' })
  })

  it('counts a timed-out command as a failure', async () => {
    class SlowSandbox extends FileSandbox {
      override async execute(): Promise<ExecutionResult> {
        throw new SandboxTimeoutError('timed out')
      }
    }
    const agent = await harness(new ScriptedModel([write(), 'Done.']), {
      sandbox: new SlowSandbox(),
      verify: { commands: ['slow'], maxAttempts: 1, timeout: 0.5 },
    })

    await agent.invoke('make it')

    expect(agent.appState.get('verification')).toEqual({
      status: 'failed',
      attempts: 1,
      checks: [{ command: 'slow', exitCode: null }],
    })
  })

  it('counts a sandbox error as a failure', async () => {
    class BrokenSandbox extends FileSandbox {
      override async execute(): Promise<ExecutionResult> {
        throw new Error('container is gone')
      }
    }
    const agent = await harness(new ScriptedModel([write(), 'Done.']), {
      sandbox: new BrokenSandbox(),
      verify: { commands: ['t'], maxAttempts: 1 },
    })

    await agent.invoke('make it')

    expect(agent.appState.get('verification')).toMatchObject({ checks: [{ command: 't', exitCode: -1 }] })
  })

  it('runs a real command in the sandbox working directory', async () => {
    const command = `"${process.execPath}" -e "process.exit(require('fs').readFileSync('out.txt','utf8') === 'x' ? 0 : 1)"`
    const agent = await harness(new ScriptedModel([write(), 'Done.']), { verify: command })

    await agent.invoke('make it')

    expect(agent.appState.get('verification')).toMatchObject({ status: 'passed' })
  })

  it('keeps the tail of long output in the feedback', async () => {
    const model = new ScriptedModel([write(), 'Done.', write(), 'Fixed.'])
    const sandbox = new ScriptedSandbox([1, 0], () => 'a'.repeat(10_000) + 'SUMMARY')
    const agent = await harness(model, { sandbox, verify: 't' })

    await agent.invoke('make it')

    const feedback = model.prompts.find((p) => p.includes('<verification>'))!
    expect(feedback).toContain('earlier characters omitted')
    expect(feedback).toContain('aaaaSUMMARY\n1 failed\n\nFix the cause')
    expect(feedback.length).toBeLessThan(5_000)
  })
})

describe("verify: 'auto'", () => {
  it.each([
    ['package.json', '{"scripts": {"test": "vitest"}}', ['npm test']],
    ['pyproject.toml', '[project]\n', ['python -m pytest -q']],
    ['Cargo.toml', '[package]\n', ['cargo test']],
    ['go.mod', 'module x\n', ['go test ./...']],
    ['Makefile', 'build:\n\ttrue\ntest:\n\ttrue\n', ['make test']],
    ['package.json', '{"scripts": {"build": "tsc"}}', []],
    ['package.json', '{"description": "a \\"test\\" helper", "devDependencies": {"test": "1"}}', []],
    ['package.json', '{"scripts": {"test": ""}}', []],
    ['package.json', '{"scripts": {"test": "vitest"', []],
    ['Makefile', 'build:\n\ttrue\n', []],
  ])('detects %s', async (path, content, expected) => {
    writeFileSync(join(dir, path), content)
    const agent = await harness(new ScriptedModel([]))
    expect(await detectChecks(agent)).toEqual(expected)
  })

  it('detects nothing in an empty project', async () => {
    expect(await detectChecks(await harness(new ScriptedModel([])))).toEqual([])
  })

  it('warns and records noChecks when nothing is detected', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    try {
      const sandbox = new ScriptedSandbox([])
      const agent = await harness(new ScriptedModel([write(), 'Done.']), { sandbox, verify: 'auto' })

      await agent.invoke('make it')

      expect(sandbox.commands).toEqual([])
      expect(agent.appState.get('verification')).toEqual({ status: 'noChecks', attempts: 0, checks: [] })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('found no test command'))
    } finally {
      configureLogging({ debug: () => {}, info: () => {}, warn: console.warn, error: console.error })
    }
  })

  it('gives a project scaffolded later its checks', async () => {
    const warn = vi.fn()
    configureLogging({ debug: () => {}, info: () => {}, warn, error: () => {} })
    try {
      const model = new ScriptedModel([write('notes.md'), 'Noted.', write(), 'Changed.', write(), 'Changed again.'])
      const sandbox = new ScriptedSandbox([0, 0])
      const agent = await harness(model, { sandbox, verify: 'auto' })

      await agent.invoke('write notes')
      expect(agent.appState.get('verification')).toMatchObject({ status: 'noChecks' })
      writeFileSync(join(dir, 'go.mod'), 'module x\n')
      await agent.invoke('add a feature')
      await agent.invoke('add another')

      expect(sandbox.commands).toEqual(['go test ./...', 'go test ./...'])
      expect(agent.appState.get('verification')).toMatchObject({ status: 'passed' })
      expect(warn.mock.calls.filter(([m]) => String(m).includes('found no test command'))).toHaveLength(1)
    } finally {
      configureLogging({ debug: () => {}, info: () => {}, warn: console.warn, error: console.error })
    }
  })

  it('runs the detected command', async () => {
    writeFileSync(join(dir, 'go.mod'), 'module x\n')
    const sandbox = new ScriptedSandbox([0])
    const agent = await harness(new ScriptedModel([write(), 'Done.']), { sandbox, verify: 'auto' })

    await agent.invoke('make it')

    expect(sandbox.commands).toEqual(['go test ./...'])
  })

  it('refuses interventions', async () => {
    await expect(harness(new ScriptedModel([]), { verify: 'auto', interventions: 'ask' })).rejects.toThrow(
      'cannot be combined with interventions'
    )
  })

  it('allows interventions with explicit commands', async () => {
    const agent = await harness(new ScriptedModel([]), { verify: 'npm test', interventions: 'ask' })
    expect(verificationOf(agent)).toBeDefined()
  })
})

describe('verify option validation', () => {
  it.each([
    [[], 'non-empty list'],
    [[''], 'non-empty list'],
    [{ commands: ['t'], maxAttempts: 0 }, 'maxAttempts'],
    [{ commands: ['t'], timeout: 0 }, 'timeout'],
    [{ commands: ['t'], retries: 2 }, 'Unknown verify key'],
    [{ maxAttempts: 2 }, "needs 'commands'"],
    [42, 'verify must be'],
  ])('rejects %j', async (verify, message) => {
    await expect(harness(new ScriptedModel([]), { verify: verify as never })).rejects.toThrow(message)
  })

  it.each([undefined, null, false])('is off for %s', async (verify) => {
    expect(verificationOf(await harness(new ScriptedModel([]), { verify }))).toBeUndefined()
  })

  it('accepts a single command in the config', async () => {
    const agent = await harness(new ScriptedModel([]), { verify: { commands: 'npm test' as never } })
    expect(verificationOf(agent)?.commands).toEqual(['npm test'])
  })

  it('refuses a GoalLoop', async () => {
    const goal = new GoalLoop({ goal: () => true, maxAttempts: 1 })
    await expect(harness(new ScriptedModel([]), { verify: 't', plugins: [goal] })).rejects.toThrow('GoalLoop')
  })

  it('refuses a second Verification', async () => {
    const plugin = new Verification({ commands: ['t'] })
    await expect(harness(new ScriptedModel([]), { verify: 't', plugins: [plugin] })).rejects.toThrow(
      'a Verification is one'
    )
  })

  it('accepts a Verification plugin on its own', async () => {
    const agent = await harness(new ScriptedModel([]), { plugins: [new Verification({ commands: ['t'] })] })
    expect(verificationOf(agent)).toBeDefined()
  })
})

describe('verify: how an invocation ends', () => {
  const so: ToolCall[] = [[SO, { summary: 'done' }]]
  const endings = ['stopSequence', 'afterToolsEndTurn', 'structuredOutput', 'invalidThenValidOutput', 'outputWithWrite']

  it.each(endings)('grades a %s ending', async (ending) => {
    // Built per test: `write()` reads the per-test `dir`.
    const turns = {
      stopSequence: [write(), { text: 'Done.', reason: 'stopSequence' as const }],
      afterToolsEndTurn: [write()],
      structuredOutput: [write(), 'Done.', so],
      invalidThenValidOutput: [write(), 'Done.', [[SO, { wrong: 1 }]] as ToolCall[], so],
      outputWithWrite: [[...write(), ...so]],
    }[ending] as Turn[]
    const sandbox = new ScriptedSandbox([0])
    const agent = await harness(new ScriptedModel(turns), { sandbox, verify: 't' })
    if (ending === 'afterToolsEndTurn') {
      agent.addHook(AfterToolsEvent, (event) => {
        event.endTurn = 'Done.'
      })
    }

    await agent.invoke('make it', /output/i.test(ending) ? { structuredOutputSchema: schema } : {})

    expect(sandbox.commands).toEqual(['t'])
    expect(agent.appState.get('verification')).toMatchObject({ status: 'passed' })
    expect(outcome(agent)).toEqual([true, 'satisfied', [true]])
  })

  it('leaves nothing pending after a read-only structured-output request', async () => {
    const sandbox = new ScriptedSandbox([])
    const agent = await harness(new ScriptedModel(['Hi.', [[SO, { summary: 'hi' }]], 'Just answering.']), {
      sandbox,
      verify: 't',
    })

    await agent.invoke('say hi', { structuredOutputSchema: schema })
    await agent.invoke('a question')

    expect(sandbox.commands).toEqual([])
    expect(agent.appState.get('verification')).toBeUndefined()
  })

  describe.each(['nothing', 'failedCheckThenWrite', 'failedCheckNoWrite'] as const)('before: %s', (before) => {
    it.each(['interrupt', 'maxTokens'] as const)('a %s is pending and checked next time', async (early) => {
      const turns: Turn[] =
        before === 'nothing'
          ? [write()]
          : before === 'failedCheckThenWrite'
            ? [write(), 'Done.', write()]
            : [write(), 'Done.']
      turns.push(early === 'interrupt' ? read() : { text: 'partial', reason: 'maxTokens' }, 'Fixed.')
      const checksBefore = before === 'nothing' ? [] : ['t']
      const sandbox = new ScriptedSandbox(checksBefore.length ? [1, 0] : [0])
      const agent = await harness(new ScriptedModel(turns), { sandbox, verify: 't' })
      gateRead(agent)

      let stopped: Awaited<ReturnType<Agent['invoke']>> | undefined
      if (early === 'maxTokens') {
        await expect(agent.invoke('make it')).rejects.toThrow()
      } else {
        stopped = await agent.invoke('make it')
      }

      expect(sandbox.commands).toEqual(checksBefore)
      expect(agent.appState.get('verification')).toMatchObject({ status: 'pending' })
      expect(outcome(agent)).toBeUndefined()

      const result =
        stopped !== undefined
          ? await agent.invoke([{ interruptResponse: { interruptId: stopped.interrupts[0]!.id, response: 'yes' } }])
          : await agent.invoke('go on')
      expect(result.toString().trim()).toBe('Fixed.')
      expect(sandbox.commands).toEqual([...checksBefore, 't'])
      expect(agent.appState.get('verification')).toEqual({
        status: 'passed',
        attempts: sandbox.commands.length,
        checks: [{ command: 't', exitCode: 0 }],
      })
      expect(outcome(agent)).toEqual([true, 'satisfied', checksBefore.length ? [false, true] : [true]])
    })
  })

  it('records pending, not passed, when a later change is interrupted', async () => {
    const sandbox = new ScriptedSandbox([0])
    const agent = await harness(new ScriptedModel([write(), 'Done.', write(), read()]), { sandbox, verify: 't' })
    gateRead(agent)

    await agent.invoke('make it')
    await agent.invoke('change more')

    expect(sandbox.commands).toEqual(['t'])
    expect(agent.appState.get('verification')).toMatchObject({ status: 'pending' })
    expect(outcome(agent)).toBeUndefined()
  })

  it('reports only what the last check said when a turn limit hits after a failed check', async () => {
    const sandbox = new ScriptedSandbox([1, 0])
    const agent = await harness(new ScriptedModel([write(), 'Done.', write(), write(), 'Fixed.']), {
      sandbox,
      verify: 't',
    })

    await agent.invoke('make it', { limits: { turns: 3 } })

    // SDK versions differ on whether GoalLoop's retry may pass the limit; either way the outcome matches the last
    // check, and 'pending' goes with no result.
    const actual = JSON.stringify([(agent.appState.get('verification') as { status: string }).status, outcome(agent)])
    const allowed =
      sandbox.commands.length === 1
        ? [JSON.stringify(['pending', undefined]), JSON.stringify(['failed', [false, 'limit', [false]]])]
        : [JSON.stringify(['passed', [true, 'satisfied', [false, true]]])]
    expect(allowed).toContain(actual)
  })

  it('keeps the attempt budget across interrupts', async () => {
    const model = new ScriptedModel([write(), 'Done.', write(), 'Done.', write(), 'Done.', write(), 'Done.'])
    const sandbox = new ScriptedSandbox([1, 1, 1, 1])
    const agent = await harness(model, { sandbox, verify: { commands: ['t'], maxAttempts: 2 } })
    agent.addHook(BeforeToolCallEvent, (event) => {
      if (event.toolUse.name === 'write') event.interrupt({ name: 'approve-write', reason: 'write?' })
    })

    let result = await agent.invoke('make it')
    for (let round = 0; result.stopReason === 'interrupt' && round < 4; round++) {
      result = await agent.invoke([{ interruptResponse: { interruptId: result.interrupts[0]!.id, response: 'yes' } }])
    }

    expect(result.stopReason).toBe('endTurn')
    expect(sandbox.commands).toEqual(['t', 't'])
    const headers = model.prompts.filter((p) => p.includes('<verification>')).map((p) => p.split('\n')[1])
    expect(headers).toEqual(["The project's checks failed after your changes (attempt 1 of 2)."])
    expect(outcome(agent)).toEqual([false, 'maxAttempts', [false, false]])
  })

  it('has no lastResult mid-invocation and keeps it per agent', async () => {
    const plugin = new Verification({ commands: ['t'] })
    const seen: unknown[] = []
    const first = await harness(new ScriptedModel([]), { sandbox: new ScriptedSandbox([]), plugins: [plugin] })
    const second = await harness(new ScriptedModel([write(), 'Done.']), {
      sandbox: new ScriptedSandbox([0]),
      plugins: [plugin],
    })
    second.addHook(BeforeToolCallEvent, (event) => {
      seen.push(plugin.lastResult(event.agent))
    })

    await second.invoke('make it')

    expect(seen).toEqual([undefined])
    expect(plugin.lastResult(second)?.passed).toBe(true)
    expect(plugin.lastResult(first)).toBeUndefined()
  })

  it('records a validator error as a failure', async () => {
    const agent = await harness(new ScriptedModel([write(), 'Done.']), {
      sandbox: new ScriptedSandbox([]),
      verify: { commands: ['t'], maxAttempts: 1 },
    })
    const checks = (verificationOf(agent) as unknown as { _checks: { _resolveCommands: () => Promise<string[]> } })
      ._checks
    checks._resolveCommands = async () => {
      throw new Error('sandbox is gone')
    }

    await agent.invoke('make it')

    expect((agent.appState.get('verification') as { checks: unknown }).checks).toEqual([
      { command: 'verify', exitCode: -1 },
    ])
    expect(outcome(agent)).toEqual([false, 'maxAttempts', [false]])
  })
})
