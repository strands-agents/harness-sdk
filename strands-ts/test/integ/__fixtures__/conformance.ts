/**
 * Model conformance: the cases and targets in shared/conformance.json, mapped to this SDK's model providers.
 */

import { appendFile } from 'node:fs/promises'
import conformance from '../../../../shared/conformance.json' with { type: 'json' }

import { anthropic, bedrock, gemini, mantle, openai, openaiResponses } from './model-providers.js'
import { ModelThrottledError } from '@strands-agents/sdk'
import type { CacheConfig, Model, ModelInfo } from '@strands-agents/sdk'

export interface ConformanceCase {
  passes: string
  requires?: string
  equals?: unknown
}

export interface ConformanceTarget {
  provider: string
  model: string
  core?: boolean
  endOfLife?: boolean
}

export interface KnownFailure extends ConformanceTarget {
  case: string
  issue: number
  error?: string
  intermittent?: boolean
}

export interface ConformanceConfig {
  cacheConfig?: CacheConfig
}

export interface ConformanceProvider {
  skip: boolean
  create: (modelId: string, config?: ConformanceConfig) => Model
}

export type ConformanceStatus = 'passed' | 'failed' | 'error' | 'skipped' | 'not-applicable'

export const cases: Record<string, ConformanceCase> = conformance.cases
export const targets: ConformanceTarget[] = conformance.targets
export const knownFailures: KnownFailure[] = conformance.knownFailures

const { intro, topics, actions } = conformance.cachePrompt

/**
 * The caching case's system prompt, one guideline per topic and action pair: about twice the largest cache minimum
 * among the targets, and ordinary prose so that no provider filters it.
 */
export const cachePrompt = [
  intro,
  ...topics.flatMap((topic, topicIndex) =>
    actions.map(
      (action, actionIndex) =>
        `${topicIndex * actions.length + actionIndex + 1}. When a customer asks about ${topic}, ${action}.`
    )
  ),
].join('\n')

/**
 * The shared known failure entry for a case on a target, or undefined when the case is expected to pass.
 *
 * @param target - The provider and model
 * @param caseId - The case id
 * @returns The entry, which names the issue that tracks the failure
 */
export function knownFailure(target: ConformanceTarget, caseId: string): KnownFailure | undefined {
  return knownFailures.find(
    (known) => known.provider === target.provider && known.model === target.model && known.case === caseId
  )
}

/**
 * Whether an error is the failure the entry tracks: a failed assertion, or an error carrying the entry's text.
 *
 * @param known - The known failure entry
 * @param error - What the case threw
 * @returns True when the error is the tracked failure
 */
export function isTrackedFailure(known: KnownFailure, error: unknown): boolean {
  if (known.error === undefined) return error instanceof Error && error.name === 'AssertionError'
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current.message.includes(known.error)) return true
  }
  return false
}

// Factories set no output token limit, so the cases run on each provider's defaults.
export const providers: Record<string, ConformanceProvider> = {
  anthropic: {
    get skip() {
      return anthropic.skip
    },
    create: (modelId, config) => anthropic.createModel({ modelId, ...config }),
  },
  // The Bedrock fixture sets no region, and the cross-region profiles in the targets are served from us-east-1.
  bedrock: {
    get skip() {
      return bedrock.skip
    },
    create: (modelId, config) => bedrock.createModel({ modelId, region: 'us-east-1', ...config }),
  },
  gemini: {
    get skip() {
      return gemini.skip
    },
    create: (modelId, config) => gemini.createModel({ modelId, ...config }),
  },
  openai: {
    get skip() {
      return openai.skip
    },
    create: (modelId, config) => openai.createModel({ modelId, ...config }),
  },
  'openai-responses': {
    get skip() {
      return openaiResponses.skip
    },
    create: (modelId, config) => openaiResponses.createModel({ modelId, ...config }),
  },
  mantle: {
    get skip() {
      return mantle.skip
    },
    create: (modelId, config) => mantle.createModel({ api: 'chat', modelId, ...config }),
  },
  'mantle-responses': {
    get skip() {
      return mantle.skip
    },
    create: (modelId, config) => mantle.createModel({ api: 'responses', modelId, ...config }),
  },
}

/** Shared provider ids this SDK does not map, with the reason. */
export const omittedProviders: Record<string, string> = {
  mistral: 'this SDK has no Mistral provider',
}

/** Shared case ids this SDK does not implement, with the reason. */
export const omittedCases: Record<string, string> = {}

/**
 * Why a case does not apply to a model, or undefined when it applies.
 *
 * @param conformanceCase - The case from the shared file
 * @param modelInfo - The model's resolved model info
 * @returns The reason the case's `requires` does not hold
 */
export function notApplicableReason(conformanceCase: ConformanceCase, modelInfo: ModelInfo): string | undefined {
  if (!conformanceCase.requires) return undefined
  let value: unknown = modelInfo
  for (const key of conformanceCase.requires.split('.')) {
    value = (value as Record<string, unknown> | undefined)?.[key]
  }
  if (value === undefined) return `${conformanceCase.requires} is unknown`
  if (conformanceCase.equals !== undefined && value !== conformanceCase.equals) {
    return `${conformanceCase.requires} is ${JSON.stringify(value)}`
  }
  return undefined
}

// HTTP statuses that mean the provider could not serve the call, which says nothing about the case.
const PROVIDER_ERROR_STATUSES = new Set([401, 403, 404, 408, 429])

// The HTTP status a vendor SDK error carries, on the error or one of its causes.
function httpStatus(error: unknown): number | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { status, $metadata } = current as { status?: unknown; $metadata?: { httpStatusCode?: unknown } }
    const found = [status, $metadata?.httpStatusCode].find((value) => typeof value === 'number')
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Why a failure is the provider's (throttling, credentials, an outage, a model that is not served), or undefined
 * when the failure is a verdict on the case.
 *
 * @param error - What the case threw
 * @returns The error name and HTTP status, when the error or one of its causes is a provider error
 */
export function providerErrorReason(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current instanceof ModelThrottledError) return current.name
  }
  const status = httpStatus(error)
  if (status !== undefined && (PROVIDER_ERROR_STATUSES.has(status) || status >= 500)) {
    return `${error instanceof Error ? error.name : 'Error'} (HTTP ${status})`
  }
  return undefined
}

/**
 * Whether another attempt cannot change the outcome: the provider rejected the request with a 4xx that is neither a
 * timeout nor a throttle, as it does for bad credentials, a model it does not serve, or an unsupported request.
 *
 * @param error - What the case threw
 * @returns True when retrying is pointless
 */
export function willNotClear(error: unknown): boolean {
  const status = httpStatus(error)
  return status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429
}

/**
 * Appends a result record to the file named by STRANDS_CONFORMANCE_RESULTS. Does nothing when the variable is unset.
 *
 * @param target - The provider and model the case ran on
 * @param caseId - The case id
 * @param status - The outcome
 * @param reason - Why the case errored, was skipped or does not apply
 */
export async function recordResult(
  target: ConformanceTarget,
  caseId: string,
  status: ConformanceStatus,
  reason?: string
): Promise<void> {
  const file = process.env.STRANDS_CONFORMANCE_RESULTS
  if (!file) return
  const record = {
    sdk: 'typescript',
    provider: target.provider,
    model: target.model,
    case: caseId,
    status,
    ...(reason && { reason }),
  }
  await appendFile(file, `${JSON.stringify(record)}\n`)
}
