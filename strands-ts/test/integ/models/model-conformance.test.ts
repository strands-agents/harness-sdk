import { describe, expect, inject, it } from 'vitest'
import { z } from 'zod'
import { Agent, Message, TextBlock } from '@strands-agents/sdk'
import { collectIterator } from '$/sdk/__fixtures__/model-test-helpers.js'
import { lookupModelInfo } from '$/sdk/models/model-info.js'
import { FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES } from '$/sdk/models/native-output.js'
import { ContextInjector } from '$/sdk/vended-plugins/context-injector/index.js'

import {
  cachePrompt,
  cases,
  knownFailure,
  notApplicableReason,
  omittedCases,
  omittedProviders,
  providerErrorReason,
  providers,
  recordResult,
  targets,
} from '../__fixtures__/conformance.js'
import { echoTool, hasToolUse, isInBrowser } from '../__fixtures__/test-helpers.js'
import type { Model } from '@strands-agents/sdk'
import type { ConformanceConfig, ConformanceStatus } from '../__fixtures__/conformance.js'

/**
 * Model conformance: every case in shared/conformance.json runs on every target it lists. A case whose `requires`
 * does not hold for the model's resolved model info is skipped as not applicable.
 */

interface CaseContext {
  modelId: string
  model: Model
  create: (config?: ConformanceConfig) => Model
}

const profileSchema = z.object({ name: z.string(), age: z.number(), occupation: z.string() })
const profilePrompt = 'Create a profile for John, a 25 year old dentist.'
const expectedProfile = { name: 'John', age: 25, occupation: expect.stringMatching(/dentist/i) }

const userMessage = (text: string): Message => new Message({ role: 'user', content: [new TextBlock(text)] })

// The Anthropic client puts the response body into its error text as JSON, which escapes the quotes in the message.
const apiErrorMessage = (error: unknown): string => {
  const message = (error as { error?: { error?: { message?: unknown } } }).error?.error?.message
  return typeof message === 'string' ? message : String(error)
}

const forcedToolChoiceOutcome = async (model: Model): Promise<'accepted' | 'refused' | 'no tool use'> => {
  // A model that accepts a forced call can still end a turn without one, so only a tool use or a refusal is final.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const events = await collectIterator(
        model.stream([userMessage('Hello there!')], { toolSpecs: [echoTool.toolSpec], toolChoice: { any: {} } })
      )
      const startsToolUse = events.some(
        (event) => event.type === 'modelContentBlockStartEvent' && event.start?.type === 'toolUseStart'
      )
      if (startsToolUse) return 'accepted'
    } catch (error) {
      const providerMessage = apiErrorMessage(error)
      if (!FORCED_TOOL_CHOICE_UNSUPPORTED_MESSAGES.some((message) => providerMessage.includes(message))) throw error
      return 'refused'
    }
  }
  return 'no tool use'
}

const implementations: Record<string, (context: CaseContext) => Promise<void>> = {
  'tool-use': async ({ model }) => {
    const agent = new Agent({ model, tools: [echoTool], printer: false })

    const result = await agent.invoke("Use the echo tool to echo the value 'pineapple'.")

    expect(result.stopReason).toBe('endTurn')
    expect(hasToolUse(agent.messages, echoTool.name)).toBe(true)
  },

  'context-window': async ({ modelId, model }) => {
    const contextWindow = lookupModelInfo(modelId).limits?.contextWindow

    expect(contextWindow, 'the model id resolves to no entry in shared/model-info.json').toBeDefined()
    expect(model.getConfig().contextWindowLimit).toBe(contextWindow)
  },

  'structured-output': async ({ model }) => {
    const agent = new Agent({ model, printer: false, structuredOutputSchema: profileSchema })

    const result = await agent.invoke(profilePrompt)

    expect(result.structuredOutput).toMatchObject(expectedProfile)
  },

  'max-output-tokens': async ({ model }) => {
    const agent = new Agent({ model, printer: false })

    const result = await agent.invoke('Reply with the single word OK.')

    expect(result.stopReason).toBe('endTurn')
  },

  'forced-tool-choice': async ({ model }) => {
    expect(await forcedToolChoiceOutcome(model)).toBe('accepted')
  },

  'forced-tool-choice-refused': async ({ model }) => {
    expect(await forcedToolChoiceOutcome(model)).toBe('refused')
  },

  'native-structured-output': async ({ model }) => {
    const events = await collectIterator(
      model.stream([userMessage(profilePrompt)], { structuredOutputSchema: profileSchema })
    )

    const text = events
      .map((event) =>
        event.type === 'modelContentBlockDeltaEvent' && event.delta.type === 'textDelta' ? event.delta.text : ''
      )
      .join('')
    expect(profileSchema.parse(JSON.parse(text))).toMatchObject(expectedProfile)
  },

  'prompt-caching': async ({ create }) => {
    // Salted so a rerun cannot read an entry an earlier run wrote.
    const systemPrompt = `Session ${globalThis.crypto.randomUUID()}.\n${cachePrompt}`
    const agent = new Agent({ model: create({ cacheConfig: { strategy: 'auto' } }), systemPrompt, printer: false })

    await agent.invoke('Reply ALPHA.')
    // An entry can take a moment to become readable, so the read may land a turn late.
    let readTokens = 0
    for (const reply of ['BETA', 'GAMMA', 'DELTA']) {
      await agent.invoke(`Reply ${reply}.`)
      const usage = agent.messages.filter((message) => message.role === 'assistant').at(-1)?.metadata?.usage
      readTokens = usage?.cacheReadInputTokens ?? 0
      if (readTokens > 0) break
    }

    expect(readTokens).toBeGreaterThan(0)
  },

  'server-side-summary': async ({ model }) => {
    const systemPrompt = 'You are helpful.'
    const messages = [
      userMessage('My name is Ada and I live in Lisbon. Remember that.'),
      new Message({ role: 'assistant', content: [new TextBlock('Got it, Ada from Lisbon.')] }),
      userMessage('My favourite colour is teal.'),
      new Message({ role: 'assistant', content: [new TextBlock('Noted: teal.')] }),
    ]

    const summary = (await model.summarize(messages, { systemPrompt })).content[0]

    expect(summary).toMatchObject({ type: 'summaryBlock', provider: expect.any(String) })

    // Mirrors how the summarize strategy splices the summary into history.
    const agent = new Agent({
      model,
      systemPrompt,
      printer: false,
      messages: [messages[0]!, new Message({ role: 'assistant', content: [summary!] })],
    })
    const answer = String(await agent.invoke('What is my name and which city do I live in?')).toLowerCase()

    expect(answer).toContain('ada')
    expect(answer).toContain('lisbon')
  },

  'temporary-messages': async ({ model }) => {
    const orderNumber = globalThis.crypto.randomUUID().slice(0, 8)
    const agent = new Agent({
      model,
      printer: false,
      plugins: [new ContextInjector({ renderContent: async () => `The user's order number is ${orderNumber}.` })],
    })

    const result = await agent.invoke('What is my order number? Reply with only the number.')

    expect(String(result)).toContain(orderNumber)
  },
}

describe('Model conformance coverage', () => {
  it('implements or leaves out every shared case', () => {
    expect([...Object.keys(implementations), ...Object.keys(omittedCases)].sort()).toStrictEqual(
      Object.keys(cases).sort()
    )
  })

  it('maps or leaves out every shared provider', () => {
    const known = new Set([...Object.keys(providers), ...Object.keys(omittedProviders)])

    expect(targets.filter((target) => !known.has(target.provider))).toStrictEqual([])
  })
})

describe.skipIf(!inject('conformanceEnabled')).each(targets)('Model conformance: $provider $model', (target) => {
  const provider = providers[target.provider]

  // Why no case can run on this target, as a result status and reason.
  const unavailable = (): ['skipped' | 'not-applicable', string] | undefined => {
    if (target.endOfLife) return ['not-applicable', 'end of life']
    if (!provider) return ['not-applicable', omittedProviders[target.provider] ?? 'provider is not mapped']
    if (provider.skip) return ['skipped', 'credentials are not available']
    if (provider.nodeOnly && isInBrowser()) return ['skipped', 'provider runs in node only']
    return undefined
  }

  for (const caseId of Object.keys(cases)) {
    const known = knownFailure(target, caseId)
    // A known failure still runs and is recorded; the run goes red when it starts passing, unless it only fails
    // some of the time. A provider can be briefly unavailable and a model can answer differently from one call to
    // the next, so every case gets three attempts, and slow reasoning models get a longer timeout.
    it(caseId, { fails: known !== undefined && !known.intermittent, timeout: 180_000, retry: 2 }, async (ctx) => {
      // Recorded when the attempt finishes, so a timeout or a throw before the case body still leaves a record.
      let status: ConformanceStatus = 'failed'
      let reason: string | undefined
      ctx.onTestFinished(() => recordResult(target, caseId, status, reason))

      const skip = (skipStatus: ConformanceStatus, skipReason: string | undefined): void => {
        status = skipStatus
        reason = skipReason
        ctx.skip(skipReason)
      }
      const [unavailableStatus, unavailableReason] = unavailable() ?? []
      if (unavailableStatus) return skip(unavailableStatus, unavailableReason)

      const run = implementations[caseId]
      const model = provider!.create(target.model)
      const notApplicable = run ? notApplicableReason(cases[caseId]!, model.modelInfo) : omittedCases[caseId]
      if (!run || notApplicable) return skip('not-applicable', notApplicable)

      try {
        await run({ modelId: target.model, model, create: (config) => provider!.create(target.model, config) })
        status = 'passed'
      } catch (error) {
        reason = providerErrorReason(error)
        if (reason) status = 'error'
        if (!known?.intermittent) throw error
      }
    })
  }
})
