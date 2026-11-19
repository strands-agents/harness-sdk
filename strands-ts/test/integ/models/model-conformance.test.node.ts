import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Agent, Message, TextBlock } from '@strands-agents/sdk'
import { collectIterator } from '$/sdk/__fixtures__/model-test-helpers.js'
import { lookupModelInfo } from '$/sdk/models/model-info.js'
import { apiErrorMessage, isUnsupportedMechanismMessage } from '$/sdk/models/native-output.js'
import { ContextInjector } from '$/sdk/vended-plugins/context-injector/index.js'

import {
  AttemptTimeoutError,
  cachePrompt,
  cases,
  isTrackedFailure,
  knownFailure,
  knownFailures,
  notApplicableReason,
  omittedCases,
  omittedProviders,
  providerErrorReason,
  providers,
  recordResult,
  toolLimitReason,
  willNotClear,
  targets,
} from '../__fixtures__/conformance.js'
import { echoTool, hasToolUse } from '../__fixtures__/test-helpers.js'
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

const forcedToolChoiceOutcome = async (model: Model): Promise<'accepted' | 'refused' | 'no tool use'> => {
  try {
    const events = await collectIterator(
      model.stream([userMessage('Hello there!')], { toolSpecs: [echoTool.toolSpec], toolChoice: { any: {} } })
    )
    const usedTool = events.some(
      (event) => event.type === 'modelContentBlockStartEvent' && event.start?.type === 'toolUseStart'
    )
    return usedTool ? 'accepted' : 'no tool use'
  } catch (error) {
    if (!isUnsupportedMechanismMessage(apiErrorMessage(error), 'forced')) throw error
    return 'refused'
  }
}

// A call that never answers would otherwise use the whole test timeout, so each attempt has its own limit. Slow
// reasoning models can take over a minute.
const withinAttemptLimit = <T>(work: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AttemptTimeoutError('the attempt did not finish within 180 seconds')), 180_000)
  })
  return Promise.race([work, limit]).finally(() => clearTimeout(timer))
}

// On a single call a model can skip a tool or ignore injected text, so these cases also retry a failed assertion.
// A target that does it often belongs in knownFailures as intermittent.
const retriesAssertions = new Set(['tool-use', 'structured-output', 'forced-tool-choice', 'temporary-messages'])

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

  it('names a live target and a case in every known failure', () => {
    const live = new Set(
      targets.filter((target) => !target.endOfLife).map(({ provider, model }) => `${provider} ${model}`)
    )

    expect(
      knownFailures.filter((known) => !live.has(`${known.provider} ${known.model}`) || !(known.case in cases))
    ).toStrictEqual([])
  })

  it('says why and names its issue in every known failure', () => {
    expect(knownFailures.filter((known) => !known.reason || known.issue === undefined)).toStrictEqual([])
  })
})

// The cases call every listed model, so they only run when asked: 'core' runs the targets marked core and any
// other value runs them all. See shared/README.md for when CI sets each.
const mode = process.env.STRANDS_CONFORMANCE

describe.skipIf(!mode).each(targets)('Model conformance: $provider $model', (target) => {
  const provider = providers[target.provider]

  // Why no case can run on this target, as a result status and reason.
  const unavailable = (): ['skipped' | 'not-applicable', string] | undefined => {
    if (target.endOfLife) return ['not-applicable', 'end of life']
    if (mode === 'core' && !target.core) return ['skipped', 'not in the core set that pull requests run']
    if (!provider) return ['not-applicable', omittedProviders[target.provider] ?? 'provider is not mapped']
    if (provider.skip) return ['skipped', 'credentials are not available']
    return undefined
  }

  for (const caseId of Object.keys(cases)) {
    const known = knownFailure(target, caseId)
    const stale = (problem: string): Error =>
      new Error(`known failure #${known?.issue} ${problem}; remove it from knownFailures in shared/conformance.json`)

    // A provider can be unavailable for a short while, so an error that may clear gets three attempts half a
    // minute apart. One that will not clear is not retried, and a failed assertion, the case's verdict, is retried
    // only for the cases named above.
    const mayPassOnRetry = (error: unknown): boolean => {
      const isVerdict = error instanceof Error && error.name === 'AssertionError'
      return isVerdict ? retriesAssertions.has(caseId) : !willNotClear(error)
    }

    // The attempts happen inside the test, so vitest's own retry is off and the timeout covers all three.
    it(caseId, { timeout: 630_000, retry: 0 }, async (ctx) => {
      // Recorded when the test finishes, so a timeout or a throw before the case body still leaves a record.
      let status: ConformanceStatus = 'failed'
      let reason: string | undefined
      let attempt = 0
      let trackedFailure: typeof known
      ctx.onTestFinished(() => recordResult(target, caseId, status, reason, attempt, trackedFailure))

      const skip = (skipStatus: ConformanceStatus, skipReason: string | undefined): void => {
        status = skipStatus
        reason = skipReason
        ctx.skip(skipReason)
      }
      const [unavailableStatus, unavailableReason] = unavailable() ?? []
      if (unavailableStatus) return skip(unavailableStatus, unavailableReason)

      const run = implementations[caseId]
      const model = provider!.create(target.model)
      const notApplicable = run
        ? (notApplicableReason(cases[caseId]!, model.modelInfo) ?? toolLimitReason(cases[caseId]!, target))
        : omittedCases[caseId]
      if (known && notApplicable) throw stale(`no longer applies (${notApplicable})`)
      if (!run || notApplicable) return skip('not-applicable', notApplicable)

      while (status !== 'passed') {
        attempt++
        try {
          await withinAttemptLimit(
            run({ modelId: target.model, model, create: (config) => provider!.create(target.model, config) })
          )
          status = 'passed'
        } catch (error) {
          reason = providerErrorReason(error)
          status = reason ? 'error' : 'failed'
          // Only the tracked failure is expected. Any other error on a known failure still fails the run.
          if (known && isTrackedFailure(known, error)) {
            trackedFailure = known
            await ctx.annotate(`known failure: ${known.reason} See #${known.issue}`)
            return
          }
          if (attempt === 3 || !mayPassOnRetry(error)) throw error
          await new Promise((resolve) => setTimeout(resolve, 30_000))
        }
      }
      if (known && !known.intermittent) throw stale('now passes')
    })
  }
})
