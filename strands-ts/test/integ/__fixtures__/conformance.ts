/**
 * Model conformance: the cases and targets in shared/conformance.json, mapped to this SDK's model providers.
 */

import conformance from '../../../../shared/conformance.json' with { type: 'json' }

import { anthropic, bedrock, gemini, mantle, openai, openaiResponses } from './model-providers.js'
import { isInBrowser } from './test-helpers.js'
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
}

export interface ConformanceConfig {
  cacheConfig?: CacheConfig
}

export interface ConformanceProvider {
  skip: boolean
  nodeOnly?: boolean
  create: (modelId: string, config?: ConformanceConfig) => Model
}

export type ConformanceStatus = 'passed' | 'failed' | 'error' | 'skipped' | 'not-applicable'

export const cases: Record<string, ConformanceCase> = conformance.cases
export const targets: ConformanceTarget[] = conformance.targets

/**
 * The issue that tracks why a case fails on a target, or undefined when it is expected to pass.
 *
 * @param target - The provider and model
 * @param caseId - The case id
 * @returns The issue number from the shared known failures
 */
export function knownFailureIssue(target: ConformanceTarget, caseId: string): number | undefined {
  return conformance.knownFailures.find(
    (known) => known.provider === target.provider && known.model === target.model && known.case === caseId
  )?.issue
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
  // Mantle authenticates with the ambient AWS credential chain, which only exists in node.
  mantle: {
    get skip() {
      return mantle.skip
    },
    nodeOnly: true,
    create: (modelId, config) => mantle.createModel({ api: 'chat', modelId, ...config }),
  },
  'mantle-responses': {
    get skip() {
      return mantle.skip
    },
    nodeOnly: true,
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
    const { status, $metadata } = current as { status?: unknown; $metadata?: { httpStatusCode?: unknown } }
    const httpStatus = [status, $metadata?.httpStatusCode].find((value) => typeof value === 'number')
    if (httpStatus !== undefined && (PROVIDER_ERROR_STATUSES.has(httpStatus) || httpStatus >= 500)) {
      return `${current.name} (HTTP ${httpStatus})`
    }
  }
  return undefined
}

/**
 * Appends a result record to the file named by STRANDS_CONFORMANCE_RESULTS. Does nothing in the browser or when
 * the variable is unset.
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
  if (isInBrowser()) return
  const file = process.env.STRANDS_CONFORMANCE_RESULTS
  if (!file) return
  const { appendFile } = await import('node:fs/promises')
  const record = { sdk: 'typescript', ...target, case: caseId, status, ...(reason && { reason }) }
  await appendFile(file, `${JSON.stringify(record)}\n`)
}
