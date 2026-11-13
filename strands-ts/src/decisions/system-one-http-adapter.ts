import { ContextWindowOverflowError, ModelError, ModelThrottledError, normalizeError } from '../errors.js'
import { Message, type ContentBlock } from '../types/messages.js'
import { Uncertain, type AnswerOf, type DecisionInput, type DecisionResult, type Question } from './types.js'

const MAX_CHOICE_COUNT = 255
const PROBABILITY_TOLERANCE = 1e-6
// System One servers such as strands-decider round each probability to 4 decimals,
// so a distribution over N choices may sum to 1 within N * 5e-5.
const PROBABILITY_ROUNDING_TOLERANCE = 5e-5

/**
 * Request mapping and limits shared by every System One transport.
 *
 * @internal
 */
export interface SystemOneRequestConfig {
  providerName: string
  /** Sent as the request's `model`; omitted when undefined so the server uses its own. */
  modelId?: string
  defaultMinConfidence: number
  maxQuestions?: number
  /** Builds the request body for APIs that differ from the System One `{ state, model, questions }` shape. */
  buildRequestBody?: (state: DecisionInput, questions: Record<string, Question>) => unknown
  /**
   * Whether Noul answers carry the API's own `confidence`. That value is reported in metadata, while
   * `Uncertain` is still decided on the shared `|2p - 1|` scale.
   */
  noulConfidenceFromProvider?: boolean
}

/** @internal */
export interface SystemOneProviderConfig extends SystemOneRequestConfig {
  endpoint: string
  apiKey: string
  modelId: string
  fetch: typeof globalThis.fetch
  /** Header that carries the API key as is. Defaults to `Authorization: Bearer <apiKey>`. */
  apiKeyHeader?: string
}

/**
 * Sends a serialized System One request and resolves to the parsed JSON response payload.
 * Rejects with a {@link ModelError} subclass when the request fails.
 *
 * @internal
 */
export type SystemOneTransport = (body: string, cancelSignal?: AbortSignal) => Promise<unknown>

/** @internal */
export function resolveDefaultMinConfidence(value: number, className: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${className} defaultMinConfidence must be in [0.0, 1.0]`)
  }
  return value
}

/** @internal */
export function resolveSystemOneProviderConfig(
  options: {
    apiKey?: string
    modelId?: string
    defaultMinConfidence?: number
    fetch?: typeof globalThis.fetch
  },
  defaults: Omit<SystemOneProviderConfig, 'apiKey' | 'modelId' | 'fetch' | 'buildRequestBody'> & {
    apiKeyEnvironmentVariable: string
    modelId: string
    className: string
  }
): SystemOneProviderConfig {
  if (typeof window !== 'undefined') {
    throw new Error(`${defaults.className} cannot run in a browser because that would expose its API key`)
  }

  const apiKey = options.apiKey?.trim() || globalThis.process?.env?.[defaults.apiKeyEnvironmentVariable]?.trim()
  if (!apiKey) {
    throw new Error(
      `${defaults.className} requires an API key: pass apiKey or set ${defaults.apiKeyEnvironmentVariable}`
    )
  }

  const modelId = options.modelId?.trim() || defaults.modelId
  const defaultMinConfidence = resolveDefaultMinConfidence(
    options.defaultMinConfidence ?? defaults.defaultMinConfidence,
    defaults.className
  )

  const fetchImplementation = options.fetch ?? globalThis.fetch
  if (typeof fetchImplementation !== 'function') {
    throw new Error(`${defaults.className} requires a fetch implementation`)
  }

  return {
    providerName: defaults.providerName,
    endpoint: defaults.endpoint,
    apiKey,
    modelId,
    defaultMinConfidence,
    fetch: (input, init) => fetchImplementation(input, init),
    ...(defaults.maxQuestions !== undefined && { maxQuestions: defaults.maxQuestions }),
    ...(defaults.apiKeyHeader !== undefined && { apiKeyHeader: defaults.apiKeyHeader }),
    ...(defaults.noulConfidenceFromProvider !== undefined && {
      noulConfidenceFromProvider: defaults.noulConfidenceFromProvider,
    }),
  }
}

interface WireNoulQuestion {
  type: 'noul'
  instructions: string
}

interface WireChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, null | ''>
}

type WireQuestion = WireNoulQuestion | WireChoiceQuestion

/**
 * Answer `type` a provider normalizes to when its API declined to answer one question. The shared parser
 * reports it as {@link Uncertain}, carrying the provider's optional `reason`, and throws for a question
 * that disabled uncertainty. Probabilities and confidence stay empty: the provider returned none.
 *
 * @internal
 */
export const REFUSED_ANSWER_TYPE = 'refused'

interface ParsedAnswer {
  answer: boolean | string | Uncertain
  probabilities: Readonly<Record<string, number>>
  /** Reported in metadata. */
  confidence: number
  /** Compared with `minConfidence`; defaults to `confidence`. */
  thresholdConfidence?: number
}

class SystemOneHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string
  ) {
    super(message)
    this.name = 'SystemOneHttpError'
  }
}

/**
 * Maps a decision request to the System One wire format, sends it through `transport`,
 * and maps the response back to a {@link DecisionResult}.
 *
 * @internal
 */
export async function askSystemOne<const Q extends Record<string, Question>>(
  config: SystemOneRequestConfig,
  transport: SystemOneTransport,
  state: DecisionInput,
  questions: Q,
  cancelSignal?: AbortSignal
): Promise<DecisionResult<Q>> {
  const questionIds = Object.keys(questions)
  if (config.maxQuestions !== undefined && questionIds.length > config.maxQuestions) {
    throw new Error(`${config.providerName} accepts at most ${config.maxQuestions} questions per request`)
  }

  const body = JSON.stringify(
    config.buildRequestBody?.(state, questions) ?? {
      state: toWireState(state),
      ...(config.modelId !== undefined && { model: config.modelId }),
      questions: toWireQuestions(questions),
    }
  )

  const startedAt = globalThis.performance.now()
  const payload = await transport(body, cancelSignal)

  const result = parseResult(payload, questions, config)
  return {
    answers: result.answers,
    ...(result.usage !== undefined && { usage: result.usage }),
    metadata: {
      latencyMs: Math.round(globalThis.performance.now() - startedAt),
      providerName: config.providerName,
      modelId: result.modelId,
      probabilities: result.probabilities,
      confidence: result.confidence,
    },
  }
}

/** @internal */
export function toWireState(state: DecisionInput): unknown {
  if (typeof state === 'string' || state.length === 0) return state
  if (state[0] instanceof Message) {
    return (state as Message[]).map((message) => ({
      role: message.role,
      content: message.content.map(toWireContentBlock),
    }))
  }
  return (state as ContentBlock[]).map(toWireContentBlock)
}

function toWireContentBlock(block: ContentBlock): unknown {
  const hasBinarySource =
    (block.type === 'audioBlock' && block.source.type === 'audioSourceBytes') ||
    (block.type === 'imageBlock' && block.source.type === 'imageSourceBytes') ||
    (block.type === 'videoBlock' && block.source.type === 'videoSourceBytes') ||
    (block.type === 'documentBlock' && block.source.type === 'documentSourceBytes')
  if (hasBinarySource) {
    throw new Error('System One decision providers do not support binary ContentBlock state')
  }
  return block.toJSON()
}

/**
 * @param choiceDescription - Value sent for each choice in `criteria`, for APIs that require a string.
 * @internal
 */
export function toWireQuestions(
  questions: Record<string, Question>,
  choiceDescription: null | '' = null
): Record<string, WireQuestion> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      if (question.choices === 'boolean') {
        return [id, { type: 'noul', instructions: question.question } satisfies WireNoulQuestion]
      }
      if (question.choices.length > MAX_CHOICE_COUNT) {
        throw new Error(`question id=<${id}> | System One APIs allow at most ${MAX_CHOICE_COUNT} choices`)
      }
      const criteria = Object.fromEntries(question.choices.map((choice) => [choice, choiceDescription]))
      return [id, { type: 'choice', instructions: question.question, criteria } satisfies WireChoiceQuestion]
    })
  )
}

/**
 * The HTTP transport for hosted System One APIs: POSTs the request with the provider's API key.
 *
 * @internal
 */
export function httpTransport(config: SystemOneProviderConfig): SystemOneTransport {
  return (body, cancelSignal) => sendHttp(config, body, cancelSignal)
}

async function sendHttp(config: SystemOneProviderConfig, body: string, cancelSignal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await config.fetch(config.endpoint, {
      method: 'POST',
      headers: {
        ...(config.apiKeyHeader !== undefined
          ? { [config.apiKeyHeader]: config.apiKey }
          : { Authorization: `Bearer ${config.apiKey}` }),
        'Content-Type': 'application/json',
      },
      body,
      ...(cancelSignal !== undefined && { signal: cancelSignal }),
    })
  } catch (error) {
    throw new ModelError(`${config.providerName} decision request failed: ${normalizeError(error).message}`, {
      cause: error,
    })
  }

  const payload = await readPayload(response)
  if (!response.ok) throw translateHttpError(config.providerName, response.status, payload)
  return payload
}

async function readPayload(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    if (response.ok) {
      throw new ModelError('decision provider returned a non-JSON response', { cause: error })
    }
    return text
  }
}

function translateHttpError(providerName: string, status: number, body: unknown): Error {
  const detail = errorDetail(body)
  const message = `${providerName} decision request failed with HTTP ${status}${detail ? `: ${detail}` : ''}`
  const cause = new SystemOneHttpError(status, body, message)
  if (status === 429 || status === 503 || status === 529) return new ModelThrottledError(message, { cause })
  if (status === 413) return new ContextWindowOverflowError(message)
  return new ModelError(message, { cause })
}

function errorDetail(body: unknown): string | undefined {
  if (typeof body === 'string') return body
  if (!isRecord(body)) return undefined
  for (const field of ['error', 'message', 'detail']) {
    const value = body[field]
    if (typeof value === 'string') return value
    if (isRecord(value) && typeof value['message'] === 'string') return value['message']
  }
  return undefined
}

function parseResult<const Q extends Record<string, Question>>(
  payload: unknown,
  questions: Q,
  config: SystemOneRequestConfig
): {
  modelId: string
  answers: { [K in keyof Q]: AnswerOf<Q[K]> }
  probabilities: { [K in keyof Q]: Readonly<Record<string, number>> }
  confidence: { [K in keyof Q]: number }
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
} {
  const response = requireRecord(payload, 'decision provider response')
  const modelId = requireNonEmptyString(response['model'], 'decision provider model')
  const rawAnswers = requireRecord(response['answers'], 'decision provider answers')
  const answers = {} as { [K in keyof Q]: AnswerOf<Q[K]> }
  const probabilities = {} as { [K in keyof Q]: Readonly<Record<string, number>> }
  const confidence = {} as { [K in keyof Q]: number }

  for (const id of Object.keys(questions) as (keyof Q)[]) {
    const question = questions[id]!
    const rawAnswer = rawAnswers[String(id)]
    if (rawAnswer === undefined)
      throw new ModelError(`decision provider omitted answer for question id=<${String(id)}>`)
    const parsed = parseAnswer(rawAnswer, question, String(id), config.noulConfidenceFromProvider === true)
    const minConfidence = resolveMinConfidence(question, config.defaultMinConfidence)
    answers[id] = resolveAnswer(parsed, minConfidence) as AnswerOf<Q[typeof id]>
    probabilities[id] = parsed.probabilities
    confidence[id] = parsed.confidence
  }

  const usage = parseUsage(response['usage'])
  return { modelId, answers, probabilities, confidence, ...(usage !== undefined && { usage }) }
}

function parseAnswer(
  rawAnswer: unknown,
  question: Question,
  id: string,
  noulConfidenceFromProvider: boolean
): ParsedAnswer {
  const answer = requireRecord(rawAnswer, `answer for question id=<${id}>`)
  if (answer['type'] === REFUSED_ANSWER_TYPE) return parseRefusedAnswer(answer, question, id)
  if (question.choices === 'boolean') return parseNoulAnswer(answer, id, noulConfidenceFromProvider)
  return parseChoiceAnswer(answer, question.choices, id)
}

function parseRefusedAnswer(answer: Record<string, unknown>, question: Question, id: string): ParsedAnswer {
  if (question.uncertainty === false) {
    throw new ModelError(`question id=<${id}> | decision provider declined to answer and uncertainty is disabled`)
  }
  const reason = answer['reason']
  return {
    answer: new Uncertain(typeof reason === 'string' ? reason : undefined),
    probabilities: {},
    confidence: 0,
  }
}

function resolveAnswer(parsed: ParsedAnswer, minConfidence: number | undefined): boolean | string | Uncertain {
  if (parsed.answer instanceof Uncertain) return parsed.answer
  const thresholdConfidence = parsed.thresholdConfidence ?? parsed.confidence
  if (minConfidence !== undefined && thresholdConfidence < minConfidence) return new Uncertain()
  return parsed.answer
}

function parseNoulAnswer(
  answer: Record<string, unknown>,
  id: string,
  noulConfidenceFromProvider: boolean
): ParsedAnswer {
  if (answer['type'] !== 'noul') {
    throw new ModelError(`answer for boolean question id=<${id}> must have type 'noul'`)
  }
  const probability = requireProbability(answer['noul'], `noul for question id=<${id}>`)
  const normalizedConfidence = Math.abs(2 * probability - 1)
  return {
    answer: probability >= 0.5,
    probabilities: { true: probability, false: 1 - probability },
    ...(noulConfidenceFromProvider
      ? {
          confidence: requireProbability(answer['confidence'], `confidence for question id=<${id}>`),
          thresholdConfidence: normalizedConfidence,
        }
      : { confidence: normalizedConfidence }),
  }
}

function parseChoiceAnswer(answer: Record<string, unknown>, choices: readonly string[], id: string): ParsedAnswer {
  if (answer['type'] !== 'choice') {
    throw new ModelError(`answer for choice question id=<${id}> must have type 'choice'`)
  }
  const selected = answer['choice']
  if (typeof selected !== 'string' || !choices.includes(selected)) {
    throw new ModelError(`answer for choice question id=<${id}> selected an unknown choice`)
  }

  const rawProbabilities = requireRecord(answer['probabilities'], `probabilities for question id=<${id}>`)
  const probabilityKeys = Object.keys(rawProbabilities)
  if (probabilityKeys.length !== choices.length || choices.some((choice) => !Object.hasOwn(rawProbabilities, choice))) {
    throw new ModelError(`probabilities for question id=<${id}> must contain exactly the requested choices`)
  }

  const probabilities = Object.fromEntries(
    choices.map((choice) => [
      choice,
      requireProbability(rawProbabilities[choice], `probability '${choice}' for id=<${id}>`),
    ])
  )
  const probabilityValues = Object.values(probabilities)
  const sum = probabilityValues.reduce((total, probability) => total + probability, 0)
  const isRounded = probabilityValues.every((p) => Math.abs(p * 1e4 - Math.round(p * 1e4)) < 1e-6)
  const tolerance = isRounded
    ? choices.length * PROBABILITY_ROUNDING_TOLERANCE + PROBABILITY_TOLERANCE
    : PROBABILITY_TOLERANCE
  if (Math.abs(sum - 1) > tolerance) {
    throw new ModelError(`probabilities for question id=<${id}> must sum to 1`)
  }
  const selectedProbability = probabilities[selected]!
  const maxProbability = Math.max(...probabilityValues)
  if (selectedProbability + PROBABILITY_TOLERANCE < maxProbability) {
    throw new ModelError(`choice for question id=<${id}> must have the highest probability`)
  }

  const providerConfidence = requireProbability(answer['confidence'], `confidence for question id=<${id}>`)
  return {
    answer: selected,
    probabilities,
    confidence: providerConfidence,
  }
}

function resolveMinConfidence(question: Question, providerDefault: number): number | undefined {
  if (question.uncertainty === false) return undefined
  if (typeof question.uncertainty === 'object' && question.uncertainty.minConfidence !== undefined) {
    return question.uncertainty.minConfidence
  }
  return providerDefault
}

function parseUsage(value: unknown): { inputTokens: number; outputTokens: number; totalTokens: number } | undefined {
  if (value === undefined || value === null) return undefined
  const usage = requireRecord(value, 'decision provider usage')
  const inputTokens = usage['input_tokens']
  const outputTokens = usage['output_tokens']
  if (typeof inputTokens !== 'number' || typeof outputTokens !== 'number' || inputTokens < 0 || outputTokens < 0) {
    return undefined
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ModelError(`${name} must be an object`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ModelError(`${name} must be a non-empty string`)
  }
  return value
}

function requireProbability(value: unknown, name: string): number {
  const probability = requireNonNegativeNumber(value, name)
  if (probability > 1) throw new ModelError(`${name} must be in [0.0, 1.0]`)
  return probability
}

function requireNonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ModelError(`${name} must be a non-negative finite number`)
  }
  return value
}
