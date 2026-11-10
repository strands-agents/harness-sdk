import { describe, expect, it } from 'vitest'
import {
  Agent,
  InterventionHandler,
  InterventionActions,
  AfterToolCallEvent,
  BeforeInvocationEvent,
  BeforeToolCallEvent,
  InterruptResponseContent,
  tool,
} from '@strands-agents/sdk'
import type { JSONValue } from '@strands-agents/sdk'
import { z } from 'zod'
import { collectGenerator } from '$/sdk/__fixtures__/model-test-helpers.js'
import { allProviders } from './__fixtures__/model-providers.js'
import {
  countToolResults,
  getToolResultText,
  resumeUntilDone,
  timeTool,
  weatherTool,
  echoTool,
} from './__fixtures__/test-helpers.js'

// ========== Intervention Handler Implementations ==========

class DenyAllToolsHandler extends InterventionHandler {
  readonly name = 'deny-all-tools'

  override beforeToolCall() {
    return InterventionActions.deny('All tool use is blocked by policy')
  }
}

class DenySpecificToolHandler extends InterventionHandler {
  readonly name = 'deny-specific-tool'
  private readonly blockedTool: string

  constructor(blockedTool: string) {
    super()
    this.blockedTool = blockedTool
  }

  override beforeToolCall(event: BeforeToolCallEvent) {
    if (event.toolUse.name === this.blockedTool) {
      return InterventionActions.deny(`Tool "${this.blockedTool}" is not allowed`)
    }
    return InterventionActions.proceed()
  }
}

class ConfirmToolHandler extends InterventionHandler {
  readonly name = 'confirm-tool'

  override beforeToolCall(event: BeforeToolCallEvent) {
    return InterventionActions.confirm(`Approve use of ${event.toolUse.name}?`)
  }
}

class PreemptiveConfirmHandler extends InterventionHandler {
  readonly name = 'preemptive-confirm'
  private readonly answer: JSONValue

  constructor(answer: JSONValue) {
    super()
    this.answer = answer
  }

  override beforeToolCall(event: BeforeToolCallEvent) {
    return InterventionActions.confirm(`Approve ${event.toolUse.name}?`, { response: this.answer })
  }
}

class GuideBeforeToolHandler extends InterventionHandler {
  readonly name = 'guide-before-tool'
  private readonly feedback: string

  constructor(feedback: string) {
    super()
    this.feedback = feedback
  }

  override beforeToolCall() {
    return InterventionActions.guide(this.feedback)
  }
}

class GuideAfterModelHandler extends InterventionHandler {
  readonly name = 'guide-after-model'
  private readonly feedback: string
  private callCount = 0
  private readonly maxGuides: number

  constructor(feedback: string, maxGuides = 1) {
    super()
    this.feedback = feedback
    this.maxGuides = maxGuides
  }

  override afterModelCall() {
    if (this.callCount < this.maxGuides) {
      this.callCount++
      return InterventionActions.guide(this.feedback)
    }
    return InterventionActions.proceed()
  }
}

class TransformToolInputHandler extends InterventionHandler {
  readonly name = 'transform-tool-input'
  private readonly transformFn: (input: Record<string, unknown>) => Record<string, unknown>

  constructor(transformFn: (input: Record<string, unknown>) => Record<string, unknown>) {
    super()
    this.transformFn = transformFn
  }

  override beforeToolCall(event: BeforeToolCallEvent) {
    const transformed = this.transformFn(event.toolUse.input as Record<string, unknown>)
    return InterventionActions.transform((e) => {
      ;(e as BeforeToolCallEvent).toolUse.input = transformed as JSONValue
    })
  }
}

class TransformToolResultHandler extends InterventionHandler {
  readonly name = 'transform-tool-result'

  override afterToolCall(_event: AfterToolCallEvent) {
    return InterventionActions.transform((e) => {
      const afterEvent = e as AfterToolCallEvent
      if (afterEvent.result.status === 'success') {
        const content = afterEvent.result.content
        for (const block of content) {
          if (block.type === 'textBlock') {
            Object.assign(block, { text: block.text.replace(/\d+/g, '[REDACTED]') })
          }
        }
      }
    })
  }
}

class DenyInvocationHandler extends InterventionHandler {
  readonly name = 'deny-invocation'

  override beforeInvocation(_event: BeforeInvocationEvent) {
    return InterventionActions.deny('Invocation blocked by policy')
  }
}

class DenyBeforeModelHandler extends InterventionHandler {
  readonly name = 'deny-before-model'

  override beforeModelCall() {
    return InterventionActions.deny('Model call blocked by intervention')
  }
}

class ErrorThrowingHandler extends InterventionHandler {
  readonly name = 'error-throw'
  override readonly onError = 'throw' as const

  override beforeToolCall(): never {
    throw new Error('Handler exploded')
  }
}

class ErrorProceedHandler extends InterventionHandler {
  readonly name = 'error-proceed'
  override readonly onError = 'proceed' as const

  override beforeToolCall(): never {
    throw new Error('Handler exploded but should continue')
  }
}

class ErrorDenyHandler extends InterventionHandler {
  readonly name = 'error-deny'
  override readonly onError = 'deny' as const

  override beforeToolCall(): never {
    throw new Error('Handler exploded and should deny')
  }
}

class CustomEvaluateConfirmHandler extends InterventionHandler {
  readonly name = 'custom-evaluate-confirm'

  override beforeToolCall(event: BeforeToolCallEvent) {
    return InterventionActions.confirm(`Approve ${event.toolUse.name}?`, {
      evaluate: (response) => response === 'MAGIC_WORD',
    })
  }
}

// ========== Tests ==========

describe.each(allProviders)('Interventions with $name', ({ name, skip, createModel, supports }) => {
  describe.skipIf(skip || !supports.tools)(`${name} Intervention Integration Tests`, () => {
    describe('deny action', () => {
      it('deny on beforeToolCall blocks tool and agent completes gracefully', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new DenyAllToolsHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })

      it('deny on beforeToolCall only blocks the specified tool', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt:
            'When asked about time and weather, use BOTH time_tool AND weather_tool. Always use both tools.',
          tools: [timeTool, weatherTool],
          interventions: [new DenySpecificToolHandler('time_tool')],
        })

        const result = await agent.invoke('What is the time and weather?')
        expect(result.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
        expect(countToolResults(agent.messages, 'success')).toBeGreaterThanOrEqual(1)
      })

      it('deny on beforeInvocation cancels the invocation', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          tools: [timeTool],
          interventions: [new DenyInvocationHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(result.lastMessage.content.some((b) => b.type === 'textBlock' && b.text.includes('DENIED'))).toBe(true)
      })

      it('deny on beforeModelCall prevents model from being called', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          tools: [timeTool],
          interventions: [new DenyBeforeModelHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(result.lastMessage.content.some((b) => b.type === 'textBlock' && b.text.includes('DENIED'))).toBe(true)
      })
    })

    describe('confirm action', () => {
      it('confirm pauses agent execution and resumes with approval', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ConfirmToolHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('interrupt')
        expect(result.interrupts).toBeDefined()
        expect(result.interrupts!.length).toBeGreaterThanOrEqual(1)
        expect(result.interrupts![0]!.name).toBe('confirm-tool')

        const finalResult = await resumeUntilDone(agent, result, () => 'yes')
        expect(finalResult.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'success')).toBeGreaterThanOrEqual(1)
      })

      it('confirm with denial blocks tool execution', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ConfirmToolHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('interrupt')

        const finalResult = await resumeUntilDone(agent, result, () => 'no')
        expect(finalResult.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })

      it('confirm with preemptive approval does not pause agent', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new PreemptiveConfirmHandler('yes')],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'success')).toBeGreaterThanOrEqual(1)
      })

      it('confirm with preemptive denial blocks tool without pausing', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new PreemptiveConfirmHandler('no')],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })

      it('confirm with custom evaluate uses custom approval logic', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new CustomEvaluateConfirmHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('interrupt')

        // 'yes' would pass default evaluate but fails custom (requires 'MAGIC_WORD')
        const deniedResult = await resumeUntilDone(agent, result, () => 'yes')
        expect(deniedResult.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })

      it('confirm with custom evaluate accepts custom approval value', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new CustomEvaluateConfirmHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('interrupt')

        const approvedResult = await resumeUntilDone(agent, result, () => 'MAGIC_WORD')
        expect(approvedResult.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'success')).toBeGreaterThanOrEqual(1)
      })
    })

    describe('guide action', () => {
      it('guide on beforeToolCall cancels tool with feedback for model', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new GuideBeforeToolHandler('Please use a different approach')],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })

      it('guide on afterModelCall triggers retry with feedback', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Answer questions directly without using tools.',
          tools: [],
          interventions: [new GuideAfterModelHandler('Please be more specific in your answer')],
        })

        const result = await agent.invoke('Hello')
        expect(result.stopReason).toBe('endTurn')

        const guidanceMessages = agent.messages.filter(
          (m) =>
            m.role === 'user' && m.content.some((b) => b.type === 'textBlock' && b.text.includes('be more specific'))
        )
        expect(guidanceMessages.length).toBeGreaterThanOrEqual(1)
      })

      it('guide on beforeModelCall injects feedback as user message', async () => {
        let guideCalled = false

        class OneTimeGuide extends InterventionHandler {
          readonly name = 'onetime-guide'
          override beforeModelCall() {
            if (!guideCalled) {
              guideCalled = true
              return InterventionActions.guide('Remember to be concise')
            }
            return InterventionActions.proceed()
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          tools: [],
          interventions: [new OneTimeGuide()],
        })

        const result = await agent.invoke('Tell me a joke')
        expect(result.stopReason).toBe('endTurn')

        const guidanceMessages = agent.messages.filter(
          (m) => m.role === 'user' && m.content.some((b) => b.type === 'textBlock' && b.text.includes('be concise'))
        )
        expect(guidanceMessages.length).toBeGreaterThanOrEqual(1)
      })
    })

    describe('transform action', () => {
      it('transform on beforeToolCall modifies tool input', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt:
            'Use the echo_tool to echo messages. When asked to echo something, call echo_tool with that message.',
          tools: [echoTool],
          interventions: [
            new TransformToolInputHandler((input) => ({
              ...input,
              message: `[TRANSFORMED] ${input.message ?? 'hello'}`,
            })),
          ],
        })

        const result = await agent.invoke('Echo the message "hello world"')
        expect(result.stopReason).toBe('endTurn')

        expect(getToolResultText(agent.messages, 'success')).toContain('[TRANSFORMED]')
      })

      it('transform on afterToolCall modifies tool output', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new TransformToolResultHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')

        expect(getToolResultText(agent.messages, 'success')).toContain('[REDACTED]')
      })
    })

    describe('multiple handlers', () => {
      it('handlers execute in registration order and first deny short-circuits', async () => {
        let secondHandlerCalled = false

        class SecondHandler extends InterventionHandler {
          readonly name = 'second-handler'
          override beforeToolCall() {
            secondHandlerCalled = true
            return InterventionActions.proceed()
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new DenyAllToolsHandler(), new SecondHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(secondHandlerCalled).toBe(false)
      })

      it('proceed from first handler allows second handler to evaluate', async () => {
        let secondHandlerCalled = false

        class ProceedFirstHandler extends InterventionHandler {
          readonly name = 'proceed-first'
          override beforeToolCall() {
            return InterventionActions.proceed()
          }
        }

        class TrackingDenyHandler extends InterventionHandler {
          readonly name = 'tracking-deny'
          override beforeToolCall() {
            secondHandlerCalled = true
            return InterventionActions.deny('Blocked by second handler')
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ProceedFirstHandler(), new TrackingDenyHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(secondHandlerCalled).toBe(true)
      })

      it('transform then deny: transform applies before deny blocks', async () => {
        let transformApplied = false

        class TrackingTransformHandler extends InterventionHandler {
          readonly name = 'tracking-transform'
          override beforeToolCall() {
            return InterventionActions.transform(() => {
              transformApplied = true
            })
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new TrackingTransformHandler(), new DenyAllToolsHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(transformApplied).toBe(true)
      })
    })

    describe('error handling', () => {
      it('onError=throw propagates handler errors', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ErrorThrowingHandler()],
        })

        await expect(agent.invoke('What time is it?')).rejects.toThrow('Handler exploded')
      })

      it('onError=proceed swallows error and allows tool to run', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ErrorProceedHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'success')).toBeGreaterThanOrEqual(1)
      })

      it('onError=deny fails closed and blocks the tool', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ErrorDenyHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })
    })

    describe('async handlers', () => {
      it('awaits async handler returning deny', async () => {
        class AsyncDenyHandler extends InterventionHandler {
          readonly name = 'async-deny'
          override async beforeToolCall() {
            await new Promise((resolve) => setTimeout(resolve, 10))
            return InterventionActions.deny('Async denial')
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new AsyncDenyHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })

      it('awaits async handler returning confirm', async () => {
        class AsyncConfirmHandler extends InterventionHandler {
          readonly name = 'async-confirm'
          override async beforeToolCall(event: BeforeToolCallEvent) {
            await new Promise((resolve) => setTimeout(resolve, 10))
            return InterventionActions.confirm(`Approve ${event.toolUse.name}?`)
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new AsyncConfirmHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('interrupt')

        const finalResult = await resumeUntilDone(agent, result, () => 'yes')
        expect(finalResult.stopReason).toBe('endTurn')
      })
    })

    describe('multi-lifecycle handlers', () => {
      it('handler can implement multiple lifecycle methods', async () => {
        let beforeToolCalled = false
        let afterToolCalled = false

        class MultiLifecycleHandler extends InterventionHandler {
          readonly name = 'multi-lifecycle'

          override beforeToolCall() {
            beforeToolCalled = true
            return InterventionActions.proceed()
          }

          override afterToolCall() {
            afterToolCalled = true
            return InterventionActions.proceed()
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new MultiLifecycleHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(beforeToolCalled).toBe(true)
        expect(afterToolCalled).toBe(true)
      })

      it('handler evaluates each tool call independently', async () => {
        let toolCallCount = 0

        class CountingHandler extends InterventionHandler {
          readonly name = 'counting-handler'
          override beforeToolCall() {
            toolCallCount++
            return InterventionActions.proceed()
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt:
            'When asked about time and weather, you MUST call BOTH time_tool AND weather_tool. Always use both.',
          tools: [timeTool, weatherTool],
          interventions: [new CountingHandler()],
        })

        const result = await agent.invoke('What is the time and weather?')
        expect(result.stopReason).toBe('endTurn')
        expect(toolCallCount).toBeGreaterThanOrEqual(2)
      })
    })

    describe('confirm with interrupt/resume flow', () => {
      it('confirm on multiple tool calls collects interrupts for each', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt:
            'When asked about time and weather, you MUST call BOTH time_tool AND weather_tool. Always use both.',
          tools: [timeTool, weatherTool],
          interventions: [new ConfirmToolHandler()],
        })

        const result = await agent.invoke('What is the time and weather?')
        expect(result.stopReason).toBe('interrupt')
        expect(result.interrupts!.length).toBeGreaterThanOrEqual(1)

        const finalResult = await resumeUntilDone(agent, result, () => 'yes')
        expect(finalResult.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'success')).toBeGreaterThanOrEqual(1)
      })

      it('confirm interrupt includes handler name and prompt as reason', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ConfirmToolHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('interrupt')

        const interrupt = result.interrupts![0]!
        expect(interrupt.name).toBe('confirm-tool')
        expect(interrupt.reason).toContain('Approve')
      })

      it('resume with InterruptResponseContent instances works', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ConfirmToolHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('interrupt')

        const responses = result.interrupts!.map(
          (interrupt) =>
            new InterruptResponseContent({
              interruptId: interrupt.id,
              response: 'yes',
            })
        )

        const resumed = await agent.invoke(responses)
        const finalResult = await resumeUntilDone(agent, resumed, () => 'yes')
        expect(finalResult.stopReason).toBe('endTurn')
      })
    })

    describe('guide accumulation across multiple handlers', () => {
      it('accumulates feedback from multiple guide handlers into one cancellation', async () => {
        class SecurityGuide extends InterventionHandler {
          readonly name = 'security-guide'
          override beforeToolCall() {
            return InterventionActions.guide('Ensure input is sanitized')
          }
        }

        class ComplianceGuide extends InterventionHandler {
          readonly name = 'compliance-guide'
          override beforeToolCall() {
            return InterventionActions.guide('Check compliance requirements')
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new SecurityGuide(), new ComplianceGuide()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)

        const errorText = getToolResultText(agent.messages, 'error')
        expect(errorText).toContain('sanitized')
        expect(errorText).toContain('compliance')
      })
    })

    describe('transform chaining', () => {
      it('multiple transforms apply in sequence and later handlers see mutations', async () => {
        class PrefixTransform extends InterventionHandler {
          readonly name = 'prefix-transform'
          override beforeToolCall(event: BeforeToolCallEvent) {
            const input = event.toolUse.input as Record<string, unknown>
            return InterventionActions.transform((e) => {
              ;(e as BeforeToolCallEvent).toolUse.input = {
                ...input,
                message: `[PREFIX] ${input.message ?? ''}`,
              } as JSONValue
            })
          }
        }

        class SuffixTransform extends InterventionHandler {
          readonly name = 'suffix-transform'
          override beforeToolCall(_event: BeforeToolCallEvent) {
            return InterventionActions.transform((e) => {
              const current = (e as BeforeToolCallEvent).toolUse.input as Record<string, unknown>
              ;(e as BeforeToolCallEvent).toolUse.input = {
                ...current,
                message: `${current.message || ''} [SUFFIX]`,
              } as JSONValue
            })
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use echo_tool to echo messages. Call echo_tool with the message provided.',
          tools: [echoTool],
          interventions: [new PrefixTransform(), new SuffixTransform()],
        })

        const result = await agent.invoke('Echo "test"')
        expect(result.stopReason).toBe('endTurn')

        const resultText = getToolResultText(agent.messages, 'success')
        expect(resultText).toContain('[PREFIX]')
        expect(resultText).toContain('[SUFFIX]')
      })

      it('transform on afterToolCall can redact sensitive data before model sees it', async () => {
        const sensitiveDataTool = tool({
          name: 'user_data_tool',
          description: 'Returns user data. Always call this tool when asked about user info.',
          inputSchema: z.object({}),
          callback: async () => 'SSN: 123-45-6789, Name: John Doe',
        })

        class RedactSSNHandler extends InterventionHandler {
          readonly name = 'redact-ssn'
          override afterToolCall(_event: AfterToolCallEvent) {
            return InterventionActions.transform((e) => {
              const afterEvent = e as AfterToolCallEvent
              for (const block of afterEvent.result.content) {
                if (block.type === 'textBlock') {
                  Object.assign(block, { text: block.text.replace(/\d{3}-\d{2}-\d{4}/g, '***-**-****') })
                }
              }
            })
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use user_data_tool to get user information.',
          tools: [sensitiveDataTool],
          interventions: [new RedactSSNHandler()],
        })

        const result = await agent.invoke('What is the user data?')
        expect(result.stopReason).toBe('endTurn')

        const resultText = getToolResultText(agent.messages, 'success')
        expect(resultText).toContain('***-**-****')
        expect(resultText).not.toContain('123-45-6789')
      })
    })

    describe('conditional interventions based on tool input', () => {
      class InputValidationHandler extends InterventionHandler {
        readonly name = 'input-validation'
        override beforeToolCall(event: BeforeToolCallEvent) {
          const input = event.toolUse.input as Record<string, unknown>
          if (typeof input.message === 'string' && input.message.includes('DROP TABLE')) {
            return InterventionActions.deny('SQL injection detected in tool input')
          }
          return InterventionActions.proceed()
        }
      }

      it('denies tool call based on input content', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use echo_tool to echo exactly what the user says. Pass their exact message.',
          tools: [echoTool],
          interventions: [new InputValidationHandler()],
        })

        const result = await agent.invoke('Echo this: DROP TABLE users')
        expect(result.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })

      it('allows tool call when input passes validation', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use echo_tool to echo what the user says.',
          tools: [echoTool],
          interventions: [new InputValidationHandler()],
        })

        const result = await agent.invoke('Echo: hello world')
        expect(result.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'success')).toBeGreaterThanOrEqual(1)
      })
    })

    describe('stateful handlers with appState', () => {
      it('handler reads appState to make policy decisions', async () => {
        class RateLimitHandler extends InterventionHandler {
          readonly name = 'rate-limit'
          override beforeToolCall(event: BeforeToolCallEvent) {
            const callCount = (event.agent.appState.get('toolCallCount') as number) ?? 0
            event.agent.appState.set('toolCallCount', callCount + 1)
            if (callCount >= 2) {
              return InterventionActions.deny('Rate limit exceeded: max 2 tool calls per session')
            }
            return InterventionActions.proceed()
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt:
            'Use the time_tool to answer time questions. If the tool fails, just say you cannot get the time.',
          tools: [timeTool],
          appState: { toolCallCount: 0 },
          interventions: [new RateLimitHandler()],
        })

        const result1 = await agent.invoke('What time is it?')
        expect(result1.stopReason).toBe('endTurn')
        expect(agent.appState.get('toolCallCount')).toBeGreaterThanOrEqual(1)

        await agent.invoke('What time is it again?')
        const finalCount = agent.appState.get('toolCallCount') as number
        expect(finalCount).toBeGreaterThanOrEqual(2)
      })

      it('handler uses appState for per-tool allow list', async () => {
        class AllowListHandler extends InterventionHandler {
          readonly name = 'allow-list'
          override beforeToolCall(event: BeforeToolCallEvent) {
            const allowedTools = (event.agent.appState.get('allowedTools') as string[]) ?? []
            if (!allowedTools.includes(event.toolUse.name)) {
              return InterventionActions.deny(`Tool "${event.toolUse.name}" is not in the allow list`)
            }
            return InterventionActions.proceed()
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool, weatherTool],
          appState: { allowedTools: ['weather_tool'] },
          interventions: [new AllowListHandler()],
        })

        const result = await agent.invoke('What is the time and weather?')
        expect(result.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })
    })

    describe('confirm with varied response types', () => {
      it('confirm accepts boolean true as approval', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ConfirmToolHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('interrupt')

        const finalResult = await resumeUntilDone(agent, result, () => true)
        expect(finalResult.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'success')).toBeGreaterThanOrEqual(1)
      })

      it('confirm rejects boolean false', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ConfirmToolHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('interrupt')

        const finalResult = await resumeUntilDone(agent, result, () => false)
        expect(finalResult.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })

      it('confirm rejects null response', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ConfirmToolHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('interrupt')

        const finalResult = await resumeUntilDone(agent, result, () => null)
        expect(finalResult.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })

      it('confirm accepts case-insensitive YES', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ConfirmToolHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('interrupt')

        const finalResult = await resumeUntilDone(agent, result, () => 'YES')
        expect(finalResult.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'success')).toBeGreaterThanOrEqual(1)
      })

      it('confirm accepts whitespace-padded "  yes  "', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ConfirmToolHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('interrupt')

        const finalResult = await resumeUntilDone(agent, result, () => '  yes  ')
        expect(finalResult.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'success')).toBeGreaterThanOrEqual(1)
      })

      it('confirm rejects empty string', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ConfirmToolHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('interrupt')

        const finalResult = await resumeUntilDone(agent, result, () => '')
        expect(finalResult.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })
    })

    describe('intervention interaction with agent lifecycle', () => {
      it('deny on beforeInvocation prevents any model or tool interaction', async () => {
        let modelCalled = false

        class TrackingDenyInvocation extends InterventionHandler {
          readonly name = 'tracking-deny-invocation'
          override beforeInvocation() {
            return InterventionActions.deny('Blocked at invocation level')
          }
          override beforeModelCall() {
            modelCalled = true
            return InterventionActions.proceed()
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          tools: [timeTool],
          interventions: [new TrackingDenyInvocation()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(modelCalled).toBe(false)
        expect(result.lastMessage.content.some((b) => b.type === 'textBlock' && b.text.includes('DENIED'))).toBe(true)
      })

      it('intervention handler can inspect tool name to apply per-tool policies', async () => {
        const toolDecisions: Record<string, string> = {}

        class PerToolPolicyHandler extends InterventionHandler {
          readonly name = 'per-tool-policy'
          override beforeToolCall(event: BeforeToolCallEvent) {
            if (event.toolUse.name === 'time_tool') {
              toolDecisions[event.toolUse.name] = 'denied'
              return InterventionActions.deny('time_tool requires elevated permissions')
            }
            toolDecisions[event.toolUse.name] = 'allowed'
            return InterventionActions.proceed()
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt:
            'When asked about time and weather, you MUST call BOTH time_tool AND weather_tool. Always use both.',
          tools: [timeTool, weatherTool],
          interventions: [new PerToolPolicyHandler()],
        })

        const result = await agent.invoke('What is the time and weather?')
        expect(result.stopReason).toBe('endTurn')
        expect(toolDecisions['time_tool']).toBe('denied')
        expect(toolDecisions['weather_tool']).toBe('allowed')
      })

      it('afterModelCall guide causes model to retry with guidance injected', async () => {
        let attemptCount = 0

        class RetryOnceGuide extends InterventionHandler {
          readonly name = 'retry-once-guide'
          override afterModelCall() {
            attemptCount++
            if (attemptCount === 1) {
              return InterventionActions.guide('Please include the word VERIFIED in your response')
            }
            return InterventionActions.proceed()
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          tools: [],
          interventions: [new RetryOnceGuide()],
        })

        const result = await agent.invoke('Say hello')
        expect(result.stopReason).toBe('endTurn')
        expect(attemptCount).toBeGreaterThanOrEqual(2)

        const guidanceMessages = agent.messages.filter(
          (m) => m.role === 'user' && m.content.some((b) => b.type === 'textBlock' && b.text.includes('VERIFIED'))
        )
        expect(guidanceMessages.length).toBeGreaterThanOrEqual(1)
      })

      it('intervention runs on every tool call in a multi-tool response', async () => {
        const toolsSeen: string[] = []

        class TrackAllToolsHandler extends InterventionHandler {
          readonly name = 'track-all-tools'
          override beforeToolCall(event: BeforeToolCallEvent) {
            toolsSeen.push(event.toolUse.name)
            return InterventionActions.proceed()
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt:
            'When asked about time and weather, you MUST call BOTH time_tool AND weather_tool in the same response.',
          tools: [timeTool, weatherTool],
          interventions: [new TrackAllToolsHandler()],
        })

        const result = await agent.invoke('What is the time and weather?')
        expect(result.stopReason).toBe('endTurn')
        expect(toolsSeen.length).toBeGreaterThanOrEqual(2)
        expect(toolsSeen).toContain('time_tool')
        expect(toolsSeen).toContain('weather_tool')
      })
    })

    describe('mixed handler strategies', () => {
      it('confirm handler followed by transform: approved tool gets transformed input', async () => {
        class ApproveAndTransform extends InterventionHandler {
          readonly name = 'approve-and-transform'
          override beforeToolCall(event: BeforeToolCallEvent) {
            return InterventionActions.confirm(`Approve ${event.toolUse.name}?`)
          }
        }

        class AddMetadata extends InterventionHandler {
          readonly name = 'add-metadata'
          override beforeToolCall(event: BeforeToolCallEvent) {
            const input = event.toolUse.input as Record<string, unknown>
            return InterventionActions.transform((e) => {
              ;(e as BeforeToolCallEvent).toolUse.input = {
                ...input,
                message: `[AUDITED] ${input.message ?? 'data'}`,
              } as JSONValue
            })
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use echo_tool to echo messages.',
          tools: [echoTool],
          interventions: [new ApproveAndTransform(), new AddMetadata()],
        })

        const result = await agent.invoke('Echo "test data"')
        expect(result.stopReason).toBe('interrupt')

        const finalResult = await resumeUntilDone(agent, result, () => 'yes')
        expect(finalResult.stopReason).toBe('endTurn')

        expect(getToolResultText(agent.messages, 'success')).toContain('[AUDITED]')
      })

      it('denied confirm short-circuits and skips subsequent transform', async () => {
        let transformApplied = false

        class ConfirmFirst extends InterventionHandler {
          readonly name = 'confirm-first'
          override beforeToolCall(event: BeforeToolCallEvent) {
            return InterventionActions.confirm(`Approve ${event.toolUse.name}?`)
          }
        }

        class TransformSecond extends InterventionHandler {
          readonly name = 'transform-second'
          override beforeToolCall() {
            return InterventionActions.transform(() => {
              transformApplied = true
            })
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ConfirmFirst(), new TransformSecond()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('interrupt')

        const finalResult = await resumeUntilDone(agent, result, () => 'no')
        expect(finalResult.stopReason).toBe('endTurn')
        expect(transformApplied).toBe(false)
      })

      it('proceed + proceed + deny: first two handlers pass, third blocks', async () => {
        const handlerLog: string[] = []

        class FirstProceed extends InterventionHandler {
          readonly name = 'first-proceed'
          override beforeToolCall() {
            handlerLog.push('first')
            return InterventionActions.proceed()
          }
        }

        class SecondProceed extends InterventionHandler {
          readonly name = 'second-proceed'
          override beforeToolCall() {
            handlerLog.push('second')
            return InterventionActions.proceed()
          }
        }

        class ThirdDeny extends InterventionHandler {
          readonly name = 'third-deny'
          override beforeToolCall() {
            handlerLog.push('third')
            return InterventionActions.deny('Blocked by third handler')
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new FirstProceed(), new SecondProceed(), new ThirdDeny()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(handlerLog).toEqual(['first', 'second', 'third'])
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })
    })

    describe('error recovery scenarios', () => {
      it('onError=proceed followed by working handler: agent uses second handler result', async () => {
        class FailingHandler extends InterventionHandler {
          readonly name = 'failing-handler'
          override readonly onError = 'proceed' as const
          override beforeToolCall(): never {
            throw new Error('External service timeout')
          }
        }

        class WorkingDenyHandler extends InterventionHandler {
          readonly name = 'working-deny'
          override beforeToolCall() {
            return InterventionActions.deny('Blocked by working handler')
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new FailingHandler(), new WorkingDenyHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })

      it('onError=deny short-circuits before later handlers run', async () => {
        let laterHandlerCalled = false

        class FailDenyHandler extends InterventionHandler {
          readonly name = 'fail-deny'
          override readonly onError = 'deny' as const
          override beforeToolCall(): never {
            throw new Error('Auth service down')
          }
        }

        class LaterHandler extends InterventionHandler {
          readonly name = 'later-handler'
          override beforeToolCall() {
            laterHandlerCalled = true
            return InterventionActions.proceed()
          }
        }

        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new FailDenyHandler(), new LaterHandler()],
        })

        const result = await agent.invoke('What time is it?')
        expect(result.stopReason).toBe('endTurn')
        expect(laterHandlerCalled).toBe(false)
      })
    })

    describe('streaming compatibility', () => {
      it('interventions work correctly when using agent.stream()', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new DenyAllToolsHandler()],
        })

        const { items, result } = await collectGenerator(agent.stream('What time is it?'))

        expect(items.length).toBeGreaterThan(0)
        expect(result.stopReason).toBe('endTurn')
        expect(countToolResults(agent.messages, 'error')).toBeGreaterThanOrEqual(1)
      })

      it('confirm interrupt works via stream API', async () => {
        const agent = new Agent({
          model: createModel(),
          printer: false,
          systemPrompt: 'Use the time_tool to answer time questions.',
          tools: [timeTool],
          interventions: [new ConfirmToolHandler()],
        })

        const { result } = await collectGenerator(agent.stream('What time is it?'))
        expect(result.stopReason).toBe('interrupt')
        expect(result.interrupts).toBeDefined()

        const finalResult = await resumeUntilDone(agent, result, () => 'yes')
        expect(finalResult.stopReason).toBe('endTurn')
      })
    })
  })
})
