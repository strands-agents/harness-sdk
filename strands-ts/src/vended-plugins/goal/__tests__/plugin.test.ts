import { describe, it, expect, vi } from 'vitest'
import { GoalLoop } from '../plugin.js'
import type { GoalAttempt, GoalResult, ValidationOutcome } from '../plugin.js'
import { buildJudgePrompt, JUDGE_OUTCOME_SCHEMA } from '../judge.js'
import { Agent } from '../../../agent/agent.js'
import { AfterInvocationEvent } from '../../../hooks/events.js'
import { MockMessageModel } from '../../../__fixtures__/mock-message-model.js'
import { JsonBlock, Message, TextBlock, ToolResultBlock, ToolUseBlock } from '../../../types/messages.js'
import type { SystemPrompt } from '../../../types/messages.js'
import { logger } from '../../../logging/logger.js'

describe('GoalLoop', () => {
  describe('constructor', () => {
    it('uses default name and unbounded budgets', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      const p = new GoalLoop({ goal: () => true, name: 'unique-defaults-test' })
      expect(p.name).toBe('unique-defaults-test')
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('execution is unbounded'))
      warnSpy.mockRestore()
    })

    it('accepts custom name', () => {
      const p = new GoalLoop({ goal: () => true, name: 'my:goal' })
      expect(p.name).toBe('my:goal')
    })

    it('throws when goal is not provided', () => {
      expect(() => new GoalLoop({} as never)).toThrow(/`goal` is required/)
    })

    it('throws when maxAttempts < 1', () => {
      expect(() => new GoalLoop({ goal: () => true, maxAttempts: 0 })).toThrow(/maxAttempts/)
    })

    it('throws when timeout < 1', () => {
      expect(() => new GoalLoop({ goal: () => true, timeout: 0 })).toThrow(/timeout/)
    })

    it('does not warn when maxAttempts is set', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
      new GoalLoop({ goal: () => true, maxAttempts: 5, name: 'bounded-by-attempts' })
      expect(warnSpy).not.toHaveBeenCalled()
      warnSpy.mockRestore()
    })
  })

  describe('function validator', () => {
    it('passes on first attempt with no resume', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'first' })
      const validator = vi.fn(() => true)
      const plugin = new GoalLoop({ goal: validator, maxAttempts: 5, name: 'fn-pass-first' })
      const agent = new Agent({ model, plugins: [plugin], printer: false })

      const result = await agent.invoke('do it')

      expect(validator).toHaveBeenCalledTimes(1)
      expect(result.lastMessage.content[0]).toEqual({ type: 'textBlock', text: 'first' })
      expect(plugin.lastResult(agent)).toEqual({
        passed: true,
        stopReason: 'satisfied',
        attempts: [{ attempt: 1, passed: true }],
      })
    })

    it('feeds feedback as user message and re-invokes until passing', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'too long' })
        .addTurn({ type: 'textBlock', text: 'still too long' })
        .addTurn({ type: 'textBlock', text: 'ok' })

      let n = 0
      const plugin = new GoalLoop({
        name: 'fn-feedback-loop',
        goal: () => {
          n++
          return n === 3 || { passed: false, feedback: `attempt ${n} too long` }
        },
        maxAttempts: 5,
      })
      const agent = new Agent({ model, plugins: [plugin], printer: false })

      await agent.invoke('summarise')

      expect(model.callCount).toBe(3)
      expect(plugin.lastResult(agent)).toEqual({
        passed: true,
        stopReason: 'satisfied',
        attempts: [
          { attempt: 1, passed: false, feedback: 'attempt 1 too long' },
          { attempt: 2, passed: false, feedback: 'attempt 2 too long' },
          { attempt: 3, passed: true },
        ],
      })

      const userTexts = agent.messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.content)
        .flatMap((b) => (b.type === 'textBlock' ? [b.text] : []))
      expect(userTexts.some((t) => t.includes('attempt 1 too long'))).toBe(true)
      expect(userTexts.some((t) => t.includes('attempt 2 too long'))).toBe(true)
    })

    it('hits maxAttempts and surfaces lastResult without throwing', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'a' })
        .addTurn({ type: 'textBlock', text: 'b' })
        .addTurn({ type: 'textBlock', text: 'c' })

      const plugin = new GoalLoop({
        name: 'fn-maxattempts',
        goal: () => ({ passed: false, feedback: 'nope' }),
        maxAttempts: 3,
      })
      const agent = new Agent({ model, plugins: [plugin], printer: false })

      await agent.invoke('go')

      expect(model.callCount).toBe(3)
      expect(plugin.lastResult(agent)).toEqual({
        passed: false,
        stopReason: 'maxAttempts',
        attempts: [
          { attempt: 1, passed: false, feedback: 'nope' },
          { attempt: 2, passed: false, feedback: 'nope' },
          { attempt: 3, passed: false, feedback: 'nope' },
        ],
      })
    })

    it('treats validator throws as a failed attempt and warns to surface buggy validators', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'a' })
        .addTurn({ type: 'textBlock', text: 'b' })

      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})

      let n = 0
      const plugin = new GoalLoop({
        name: 'fn-throws',
        goal: () => {
          n++
          if (n === 1) throw new Error('boom')
          return true
        },
        maxAttempts: 3,
      })
      const agent = new Agent({ model, plugins: [plugin], printer: false })

      await agent.invoke('go')

      expect(plugin.lastResult(agent)).toEqual({
        passed: true,
        stopReason: 'satisfied',
        attempts: [
          { attempt: 1, passed: false, feedback: 'Validator error: boom' },
          { attempt: 2, passed: true },
        ],
      })
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fn-throws: validator threw: boom'))
      warnSpy.mockRestore()
    })

    it('awaits async validator', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'a' })
        .addTurn({ type: 'textBlock', text: 'b' })

      let n = 0
      const plugin = new GoalLoop({
        name: 'fn-async',
        goal: async () => {
          n++
          const localN = n
          await new Promise((r) => setTimeout(r, 1))
          return localN === 2
        },
        maxAttempts: 5,
      })
      const agent = new Agent({ model, plugins: [plugin], printer: false })

      await agent.invoke('go')

      expect(plugin.lastResult(agent)).toEqual({
        passed: true,
        stopReason: 'satisfied',
        attempts: [
          { attempt: 1, passed: false },
          { attempt: 2, passed: true },
        ],
      })
    })

    it('exposes the assistant message to the validator', async () => {
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'hello world' })
      const seen: Message[] = []
      const plugin = new GoalLoop({
        name: 'fn-receives-message',
        goal: (response) => {
          seen.push(response)
          return true
        },
        maxAttempts: 3,
      })
      const agent = new Agent({ model, plugins: [plugin], printer: false })

      await agent.invoke('go')

      expect(seen).toHaveLength(1)
      expect(seen[0]!.role).toBe('assistant')
      expect((seen[0]!.content[0] as TextBlock).text).toBe('hello world')
    })

    it('honours timeout by terminating before next validate', async () => {
      vi.useFakeTimers()
      try {
        const model = new MockMessageModel()
          .addTurn({ type: 'textBlock', text: 'a' })
          .addTurn({ type: 'textBlock', text: 'b' })

        let attemptCount = 0
        const plugin = new GoalLoop({
          name: 'fn-timeout',
          goal: async () => {
            attemptCount++
            if (attemptCount === 1) {
              await new Promise((resolve) => setTimeout(resolve, 30))
              return { passed: false, feedback: 'try again' } satisfies ValidationOutcome
            }
            return true
          },
          timeout: 10,
          maxAttempts: 5,
        })
        const agent = new Agent({ model, plugins: [plugin], printer: false })

        const invokePromise = agent.invoke('go')
        await vi.runAllTimersAsync()
        await invokePromise

        expect(plugin.lastResult(agent)).toEqual({
          passed: false,
          stopReason: 'timeout',
          attempts: [{ attempt: 1, passed: false, feedback: 'try again' }],
        })
        expect(model.callCount).toBe(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('lastResult lifecycle', () => {
    it('is undefined before first invoke', () => {
      const plugin = new GoalLoop({ goal: () => true, maxAttempts: 1, name: 'lr-untouched' })
      const model = new MockMessageModel()
      const agent = new Agent({ model, plugins: [plugin], printer: false })
      expect(plugin.lastResult(agent)).toBeUndefined()
    })

    it('is replaced on each completed run', async () => {
      const plugin = new GoalLoop({
        name: 'lr-replaced',
        goal: () => true,
        maxAttempts: 1,
      })

      const m1 = new MockMessageModel().addTurn({ type: 'textBlock', text: 'one' })
      const a1 = new Agent({ model: m1, plugins: [plugin], printer: false })
      await a1.invoke('first')
      const after1 = plugin.lastResult(a1)
      expect(after1).toEqual({
        passed: true,
        stopReason: 'satisfied',
        attempts: [{ attempt: 1, passed: true }],
      })

      m1.addTurn({ type: 'textBlock', text: 'two' })
      await a1.invoke('second')
      const after2 = plugin.lastResult(a1)
      expect(after2).not.toBe(after1)
      expect(after2).toEqual({
        passed: true,
        stopReason: 'satisfied',
        attempts: [{ attempt: 1, passed: true }],
      })
    })

    it('is undefined after a host throw mid-run', async () => {
      const model = new MockMessageModel().addTurn(new Error('boom'))
      const plugin = new GoalLoop({
        name: 'lr-throw',
        goal: () => true,
        maxAttempts: 3,
      })
      const agent = new Agent({ model, plugins: [plugin], printer: false })

      await expect(agent.invoke('go')).rejects.toThrow('boom')
      expect(plugin.lastResult(agent)).toBeUndefined()
    })

    it('is undefined while a run is mid-flight (read between attempts via hook)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'a' })
        .addTurn({ type: 'textBlock', text: 'b' })

      const observed: Array<GoalResult | undefined> = []
      let plugin: GoalLoop
      plugin = new GoalLoop({
        name: 'lr-midflight',
        goal: (response, hostAgent) => {
          observed.push(plugin.lastResult(hostAgent))
          const text = (response.content[0] as TextBlock).text
          return text === 'b'
        },
        maxAttempts: 5,
      })
      const agent = new Agent({ model, plugins: [plugin], printer: false })

      await agent.invoke('go')

      expect(observed).toEqual([undefined, undefined])
      expect(plugin.lastResult(agent)).toEqual({
        passed: true,
        stopReason: 'satisfied',
        attempts: [
          { attempt: 1, passed: false },
          { attempt: 2, passed: true },
        ],
      })
    })
  })

  describe('conversation history', () => {
    it('feedback messages accumulate as user-role messages between attempts', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'a1' })
        .addTurn({ type: 'textBlock', text: 'a2' })
        .addTurn({ type: 'textBlock', text: 'a3' })

      let n = 0
      const plugin = new GoalLoop({
        name: 'history-accumulates',
        goal: () => {
          n++
          return n === 3 ? true : { passed: false, feedback: `fb${n}` }
        },
        maxAttempts: 5,
      })
      const agent = new Agent({ model, plugins: [plugin], printer: false })

      await agent.invoke('initial input')

      const roles = agent.messages.map((m) => m.role)
      expect(roles).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
    })
  })

  describe('resumePromptTemplate override', () => {
    it('replaces the default canned English with the user-supplied template', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'a' })
        .addTurn({ type: 'textBlock', text: 'b' })

      let n = 0
      const plugin = new GoalLoop({
        name: 'custom-resume-template',
        goal: () => {
          n++
          return n === 2 || { passed: false, feedback: 'too long' }
        },
        maxAttempts: 3,
        resumePromptTemplate: (fb) => `RETRY_TOKEN feedback=<${fb ?? 'none'}>`,
      })
      const agent = new Agent({ model, plugins: [plugin], printer: false })

      await agent.invoke('go')

      // The template's output must show up verbatim as a user message; the
      // default English must NOT.
      const userTexts = agent.messages
        .filter((m) => m.role === 'user')
        .flatMap((m) => m.content)
        .flatMap((b) => (b.type === 'textBlock' ? [b.text] : []))
      expect(userTexts.some((t) => t.includes('RETRY_TOKEN feedback=<too long>'))).toBe(true)
      expect(userTexts.some((t) => t.includes('Refine your response'))).toBe(false)
    })
  })

  describe('multiple plugin instances', () => {
    it('shares one plugin across multiple agents with independent run state', async () => {
      // Per-agent run state is keyed off the agent (WeakMap), so concurrent or
      // sequential runs on different agents don't conflate results.
      const m1 = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'a1-attempt-1' })
        .addTurn({ type: 'textBlock', text: 'a1-attempt-2' })
      const m2 = new MockMessageModel().addTurn({ type: 'textBlock', text: 'a2-only' })

      let n1 = 0
      const plugin = new GoalLoop({
        name: 'shared',
        goal: (response) => {
          const text = (response.content[0] as TextBlock).text
          if (text.startsWith('a2')) return true
          n1++
          return n1 === 2
        },
        maxAttempts: 5,
      })

      const a1 = new Agent({ model: m1, plugins: [plugin], printer: false })
      const a2 = new Agent({ model: m2, plugins: [plugin], printer: false })

      await a1.invoke('first')
      await a2.invoke('second')

      expect(plugin.lastResult(a1)).toEqual({
        passed: true,
        stopReason: 'satisfied',
        attempts: [
          { attempt: 1, passed: false },
          { attempt: 2, passed: true },
        ],
      })
      expect(plugin.lastResult(a2)).toEqual({
        passed: true,
        stopReason: 'satisfied',
        attempts: [{ attempt: 1, passed: true }],
      })
    })

    it('throws when two GoalLoops are attached to the same agent', async () => {
      // Two GoalLoops both write `event.resume` in AfterInvocationEvent — last
      // writer wins, silently dropping one's feedback. Compose constraints in a
      // single validator function instead.
      const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'x' })
      const a = new GoalLoop({ goal: () => true, maxAttempts: 1, name: 'first' })
      const b = new GoalLoop({ goal: () => true, maxAttempts: 1, name: 'second' })
      const agent = new Agent({ model, plugins: [a, b], printer: false })

      await expect(agent.invoke('go')).rejects.toThrow(/another GoalLoop is already attached/)
    })
  })

  describe('preserveContext: false', () => {
    it('restores the post-input transcript between attempts; agent never sees prior attempts', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'attempt-1' })
        .addTurn({ type: 'textBlock', text: 'attempt-2' })
        .addTurn({ type: 'textBlock', text: 'attempt-3' })

      const messageSnapshots: Array<Array<{ role: string; text: string }>> = []
      let n = 0
      const plugin = new GoalLoop({
        name: 'fresh-context',
        goal: () => {
          n++
          return n === 3 ? true : { passed: false, feedback: `fb${n}` }
        },
        maxAttempts: 5,
        preserveContext: false,
      })
      const agent = new Agent({ model, plugins: [plugin], printer: false })

      // Spy on stream to capture the messages array sent to the model on each
      // attempt. With fresh-context on, the model should never see prior
      // assistant attempts in the transcript.
      const originalStream = model.stream.bind(model)
      vi.spyOn(model, 'stream').mockImplementation(async function* (messages, options) {
        messageSnapshots.push(
          messages.map((m) => ({
            role: m.role,
            text: m.content.flatMap((b) => (b.type === 'textBlock' ? [b.text] : [])).join(''),
          }))
        )
        yield* originalStream(messages, options)
      })

      await agent.invoke('do the thing')

      expect(plugin.lastResult(agent)).toEqual({
        passed: true,
        stopReason: 'satisfied',
        attempts: [
          { attempt: 1, passed: false, feedback: 'fb1' },
          { attempt: 2, passed: false, feedback: 'fb2' },
          { attempt: 3, passed: true },
        ],
      })

      // Each attempt's transcript: clean input + accumulated feedback only.
      // The model must never see prior `attempt-N` assistant turns.
      expect(messageSnapshots).toEqual([
        [{ role: 'user', text: 'do the thing' }],
        [
          { role: 'user', text: 'do the thing' },
          { role: 'user', text: expect.stringContaining('fb1') },
        ],
        [
          { role: 'user', text: 'do the thing' },
          { role: 'user', text: expect.stringContaining('fb2') },
        ],
      ])
    })

    it('does not roll back appState mutations made during attempts', async () => {
      // Locks in the contract: Ralph mode rewinds *only* messages. Other
      // session-scope state (appState, modelState, systemPrompt, interrupts)
      // accumulates across attempts so other plugins are unaffected.
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'attempt-1' })
        .addTurn({ type: 'textBlock', text: 'attempt-2' })

      let n = 0
      const plugin = new GoalLoop({
        name: 'fresh-context-appstate',
        goal: () => {
          n++
          return n === 2 || { passed: false, feedback: 'retry' }
        },
        maxAttempts: 3,
        preserveContext: false,
      })
      const agent = new Agent({ model, plugins: [plugin], printer: false })
      // Mutate appState from a hook that runs between attempts to confirm
      // the mutation survives the rewind.
      agent.appState.set('counter', 0)
      agent.addHook(AfterInvocationEvent, () => {
        const current = (agent.appState.get('counter') as number) ?? 0
        agent.appState.set('counter', current + 1)
      })

      await agent.invoke('go')

      // counter incremented once per AfterInvocationEvent call (one per attempt).
      expect(agent.appState.get('counter')).toBe(2)
    })

    it('preserves context by default (agent sees prior assistant attempts)', async () => {
      const model = new MockMessageModel()
        .addTurn({ type: 'textBlock', text: 'attempt-1' })
        .addTurn({ type: 'textBlock', text: 'attempt-2' })

      let n = 0
      const plugin = new GoalLoop({
        name: 'fresh-context-off',
        goal: () => {
          n++
          return n === 2 || { passed: false, feedback: 'fb' }
        },
        maxAttempts: 3,
      })
      const agent = new Agent({ model, plugins: [plugin], printer: false })

      await agent.invoke('go')

      // Default behavior: attempt 2's transcript includes attempt-1's assistant turn.
      const roles = agent.messages.map((m) => m.role)
      expect(roles).toEqual(['user', 'assistant', 'user', 'assistant'])
    })
  })

  describe('cross-invocation lastResult lifecycle', () => {
    it('clears stale lastResult after a thrown invoke when a fresh invoke starts', async () => {
      const model = new MockMessageModel().addTurn(new Error('boom')).addTurn({ type: 'textBlock', text: 'ok' })
      const plugin = new GoalLoop({
        name: 'throw-then-clean',
        goal: () => true,
        maxAttempts: 3,
      })
      const agent = new Agent({ model, plugins: [plugin], printer: false })

      await expect(agent.invoke('first')).rejects.toThrow('boom')
      expect(plugin.lastResult(agent)).toBeUndefined()

      await agent.invoke('second')
      expect(plugin.lastResult(agent)).toEqual({
        passed: true,
        stopReason: 'satisfied',
        attempts: [{ attempt: 1, passed: true }],
      })
    })
  })
})

describe('judge helpers', () => {
  it('JUDGE_OUTCOME_SCHEMA validates pass/fail outcome shapes', () => {
    expect(JUDGE_OUTCOME_SCHEMA.parse({ passed: true })).toEqual({ passed: true })
    expect(JUDGE_OUTCOME_SCHEMA.parse({ passed: false, feedback: 'x' })).toEqual({
      passed: false,
      feedback: 'x',
    })
    expect(() => JUDGE_OUTCOME_SCHEMA.parse({ passed: 'yes' })).toThrow()
  })

  it('buildJudgePrompt embeds the goal description and a role-tagged transcript', () => {
    const prompt = buildJudgePrompt('be concise', [
      new Message({ role: 'user', content: [new TextBlock('hello?')] }),
      new Message({ role: 'assistant', content: [new TextBlock('hi there')] }),
    ])
    expect(prompt).toContain('Goal:\nbe concise')
    expect(prompt).toContain('[user]\nhello?')
    expect(prompt).toContain('[assistant]\nhi there')
  })

  it('buildJudgePrompt summarises tool calls and results so the judge can grade tool-using agents', () => {
    const prompt = buildJudgePrompt('ran the tests', [
      new Message({ role: 'user', content: [new TextBlock('run the tests')] }),
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 'shell', toolUseId: 't1', input: { cmd: 'npm test' } })],
      }),
      new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 't1',
            status: 'success',
            content: [new TextBlock('all green')],
          }),
        ],
      }),
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 'shell', toolUseId: 't2', input: { cmd: 'echo done' } })],
      }),
      new Message({
        role: 'user',
        content: [
          new ToolResultBlock({
            toolUseId: 't2',
            status: 'error',
            content: [new JsonBlock({ json: { code: 1 } })],
          }),
        ],
      }),
    ])
    expect(prompt).toContain('[tool-call: shell] input={"cmd":"npm test"}')
    expect(prompt).toContain('[tool-result: success] all green')
    expect(prompt).toContain('[tool-call: shell] input={"cmd":"echo done"}')
    expect(prompt).toContain('[tool-result: error] {"code":1}')
  })

  it('buildJudgePrompt truncates very long tool inputs and outputs', () => {
    const longInput = 'x'.repeat(2000)
    const prompt = buildJudgePrompt('ok', [
      new Message({
        role: 'assistant',
        content: [new ToolUseBlock({ name: 'shell', toolUseId: 't1', input: { data: longInput } })],
      }),
    ])
    expect(prompt).toContain('… [')
    expect(prompt).toContain('more chars]')
    expect(prompt.length).toBeLessThan(longInput.length)
  })
})

// String-validator (NL judge) integration tests use the same MockMessageModel
// pattern: the host agent's model is mocked, and the judge agent — which the
// plugin builds internally — shares that mock model. Each `judge.invoke` consumes
// a turn from the model, returning a `strands_structured_output` tool use that the
// agent loop validates against JUDGE_OUTCOME_SCHEMA.
describe('GoalLoop natural-language judge', () => {
  let judgeCallCount = 0
  function buildJudgeTurn(passed: boolean, feedback?: string): Parameters<MockMessageModel['addTurn']> {
    const input = feedback !== undefined ? { passed, feedback } : { passed }
    return [
      {
        type: 'toolUseBlock',
        name: 'strands_structured_output',
        toolUseId: `judge-${++judgeCallCount}`,
        input,
      },
    ]
  }

  it('judges via the host agent model by default; passing on first attempt', async () => {
    const model = new MockMessageModel()
      .addTurn({ type: 'textBlock', text: 'rainbows are pretty' })
      .addTurn(...buildJudgeTurn(true))

    const plugin = new GoalLoop({
      name: 'nl-default-pass',
      goal: 'be concise',
      maxAttempts: 3,
    })
    const agent = new Agent({ model, plugins: [plugin], printer: false })

    await agent.invoke('explain rainbows')

    expect(plugin.lastResult(agent)).toEqual({
      passed: true,
      stopReason: 'satisfied',
      attempts: [{ attempt: 1, passed: true }],
    })
  })

  it('judges via the host agent auxModel when no judge model is configured', async () => {
    const model = new MockMessageModel().addTurn({ type: 'textBlock', text: 'rainbows are pretty' })
    const auxModel = new MockMessageModel().addTurn(...buildJudgeTurn(true))
    const modelStreamSpy = vi.spyOn(model, 'stream')
    const auxStreamSpy = vi.spyOn(auxModel, 'stream')

    const plugin = new GoalLoop({ name: 'nl-aux-model', goal: 'be concise', maxAttempts: 3 })
    const agent = new Agent({ model, auxModel, plugins: [plugin], printer: false })

    await agent.invoke('explain rainbows')

    expect(plugin.lastResult(agent)?.passed).toBe(true)
    expect(modelStreamSpy).toHaveBeenCalledTimes(1)
    expect(auxStreamSpy).toHaveBeenCalledTimes(1)
  })

  it('feeds judge feedback back to the host agent', async () => {
    const model = new MockMessageModel()
      .addTurn({ type: 'textBlock', text: 'first try (long)' })
      .addTurn(...buildJudgeTurn(false, 'too long'))
      .addTurn({ type: 'textBlock', text: 'second try (short)' })
      .addTurn(...buildJudgeTurn(true))

    const plugin = new GoalLoop({
      name: 'nl-feedback',
      goal: 'be concise',
      maxAttempts: 3,
    })
    const agent = new Agent({ model, plugins: [plugin], printer: false })

    await agent.invoke('explain something')

    expect(plugin.lastResult(agent)).toEqual({
      passed: true,
      stopReason: 'satisfied',
      attempts: [
        { attempt: 1, passed: false, feedback: 'too long' },
        { attempt: 2, passed: true },
      ],
    })
    const userTexts = agent.messages
      .filter((m) => m.role === 'user')
      .flatMap((m) => m.content)
      .flatMap((b) => (b.type === 'textBlock' ? [b.text] : []))
    expect(userTexts.some((t) => t.includes('too long'))).toBe(true)
  })

  it('passes when the judge replies with plain text first and the structured-output retry yields a tool call', async () => {
    const model = new MockMessageModel()
      .addTurn({ type: 'textBlock', text: 'response' })
      .addTurn({ type: 'textBlock', text: 'judge says hi (no tool)' })
      .addTurn(...buildJudgeTurn(true))

    const plugin = new GoalLoop({
      name: 'nl-judge-passes-on-retry',
      goal: 'be concise',
      maxAttempts: 3,
    })
    const agent = new Agent({ model, plugins: [plugin], printer: false })

    await agent.invoke('go')

    expect(plugin.lastResult(agent)).toEqual({
      passed: true,
      stopReason: 'satisfied',
      attempts: [{ attempt: 1, passed: true }],
    })
  })

  it('builds a fresh judge agent per validation, not leaking prior prompts', async () => {
    const model = new MockMessageModel()
      .addTurn({ type: 'textBlock', text: 'attempt-1-host' })
      .addTurn(...buildJudgeTurn(false, 'fb-1'))
      .addTurn({ type: 'textBlock', text: 'attempt-2-host' })
      .addTurn(...buildJudgeTurn(true))

    const messageLengths: number[] = []
    const originalStream = model.stream.bind(model)
    vi.spyOn(model, 'stream').mockImplementation(async function* (messages, options) {
      messageLengths.push(messages.length)
      yield* originalStream(messages, options)
    })

    const plugin = new GoalLoop({
      name: 'nl-fresh-judge-per-call',
      goal: 'be concise',
      maxAttempts: 3,
    })
    const agent = new Agent({ model, plugins: [plugin], printer: false })

    await agent.invoke('initial')

    expect(plugin.lastResult(agent)).toEqual({
      passed: true,
      stopReason: 'satisfied',
      attempts: [
        { attempt: 1, passed: false, feedback: 'fb-1' },
        { attempt: 2, passed: true },
      ],
    })
    // Stream calls in order: host-1 (1 msg), judge-1 (1 msg), host-2 (3 msgs:
    // user+assistant+user-feedback), judge-2 (1 msg). The 1s on the judge calls
    // confirm a fresh Agent — accumulated state would push the second to >1.
    expect(messageLengths).toEqual([1, 1, 3, 1])
  })

  it('uses judge.model override when provided (different model instance)', async () => {
    const hostModel = new MockMessageModel().addTurn({ type: 'textBlock', text: 'response' })
    const judgeModel = new MockMessageModel().addTurn(...buildJudgeTurn(true))
    const hostSpy = vi.spyOn(hostModel, 'stream')
    const judgeSpy = vi.spyOn(judgeModel, 'stream')

    const plugin = new GoalLoop({
      name: 'nl-override-model',
      goal: 'be concise',
      judge: { model: judgeModel },
      maxAttempts: 1,
    })
    const agent = new Agent({ model: hostModel, plugins: [plugin], printer: false })

    await agent.invoke('go')

    expect(plugin.lastResult(agent)).toEqual({
      passed: true,
      stopReason: 'satisfied',
      attempts: [{ attempt: 1, passed: true }],
    })
    expect(hostSpy).toHaveBeenCalledTimes(1)
    expect(judgeSpy).toHaveBeenCalledTimes(1)
  })

  it('uses judge.systemPrompt override as the judge agent system prompt', async () => {
    const model = new MockMessageModel()
      .addTurn({ type: 'textBlock', text: 'response' })
      .addTurn(...buildJudgeTurn(true))

    // The judge agent is built internally; the only way it reaches the model is
    // via the system prompt threaded into the stream call. Assert the override
    // shows up there.
    const systemPrompts: Array<SystemPrompt | undefined> = []
    const originalStream = model.stream.bind(model)
    vi.spyOn(model, 'stream').mockImplementation(async function* (messages, options) {
      systemPrompts.push(options?.systemPrompt)
      yield* originalStream(messages, options)
    })

    const plugin = new GoalLoop({
      name: 'nl-override-system-prompt',
      goal: 'be concise',
      judge: { systemPrompt: 'CUSTOM_JUDGE_RUBRIC_MARKER' },
      maxAttempts: 1,
    })
    const agent = new Agent({ model, plugins: [plugin], printer: false })

    await agent.invoke('go')

    // Stream call order: host turn (no judge system prompt), then judge turn
    // (carrying the override).
    expect(systemPrompts).toContain('CUSTOM_JUDGE_RUBRIC_MARKER')
  })
})

const _typeCheck: GoalAttempt = { attempt: 1, passed: true }
void _typeCheck
