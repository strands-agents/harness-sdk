import { ContextWindowOverflowError, ModelError, ModelThrottledError, normalizeError } from '../errors.js'
import { Message, type ContentBlock } from '../types/messages.js'
import { Uncertain, type AnswerOf, type DecisionInput, type DecisionResult, type Question } from './types.js'

const MAX_CHOICE_COUNT = 255
const PROBABILITY_TOLERANCE = 1e-6

/** @internal */
export interface SystemOneProviderConfig {
  providerName: string
  endpoint: string
  apiKey: string
  modelId: string
  defaultMinConfidence: number
  fetch: typeof globalThis.fetch
  maxQuestions?: number
  maxBodyBytes: number
}

/** @internal */
export function resolveSystemOneProviderConfig(
  options: {
    apiKey?: string
    modelId?: string
    defaultMinConfidence?: number
    fetch?: typeof globalThis.fetch
  },
  defaults: Omit<SystemOneProviderConfig, 'apiKey' | 'modelId' | 'fetch'> & {
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
  const defaultMinConfidence = options.defaultMinConfidence ?? defaults.defaultMinConfidence
  if (!Number.isFinite(defaultMinConfidence) || defaultMinConfidence < 0 || defaultMinConfidence > 1) {
    throw new Error(`${defaults.className} defaultMinConfidence must be in [0.0, 1.0]`)
  }

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
    maxBodyBytes: defaults.maxBodyBytes,
  }
}

interface WireNoulQuestion {
  type: 'noul'
  instructions: string
}

interface WireChoiceQuestion {
  type: 'choice'
  instructions: string
  criteria: Record<string, null>
}

type WireQuestion = WireNoulQuestion | WireChoiceQuestion

interface ParsedAnswer {
  answer: boolean | string
  probabilities: Readonly<Record<string, number>>
  confidence: number
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

/** @internal */
export async function askSystemOne<const Q extends Record<string, Question>>(
  config: SystemOneProviderConfig,
  state: DecisionInput,
  questions: Q
): Promise<DecisionResult<Q>> {
  const questionIds = Object.keys(questions)
  if (config.maxQuestions !== undefined && questionIds.length > config.maxQuestions) {
    throw new Error(`${config.providerName} accepts at most ${config.maxQuestions} questions per request`)
  }

  const body = JSON.stringify({
    state: toWireState(state),
    model: config.modelId,
    questions: toWireQuestions(questions),
  })
  const bodyBytes = new TextEncoder().encode(body).byteLength
  if (bodyBytes > config.maxBodyBytes) {
    throw new ContextWindowOverflowError(
      `${config.providerName} decision request is ${bodyBytes} bytes; the provider limit is ${config.maxBodyBytes}`
    )
  }

  const startedAt = globalThis.performance.now()
  let response: Response
  try {
    response = await config.fetch(config.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    })
  } catch (error) {
    throw new ModelError(`${config.providerName} decision request failed: ${normalizeError(error).message}`, {
      cause: error,
    })
  }

  const payload = await readPayload(response)
  if (!response.ok) throw translateHttpError(config.providerName, response.status, payload)

  const result = parseResult(payload, questions, config.defaultMinConfidence)
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

function toWireState(state: DecisionInput): unknown {
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

function toWireQuestions(questions: Record<string, Question>): Record<string, WireQuestion> {
  return Object.fromEntries(
    Object.entries(questions).map(([id, question]) => {
      if (question.choices === 'boolean') {
        return [id, { type: 'noul', instructions: question.question } satisfies WireNoulQuestion]
      }
      if (question.choices.length > MAX_CHOICE_COUNT) {
        throw new Error(`question id=<${id}> | System One APIs allow at most ${MAX_CHOICE_COUNT} choices`)
      }
      const criteria = Object.fromEntries(question.choices.map((choice) => [choice, null]))
      return [id, { type: 'choice', instructions: question.question, criteria } satisfies WireChoiceQuestion]
    })
  )
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
  if (status === 429 || status === 529) return new ModelThrottledError(message, { cause })
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
  defaultMinConfidence: number
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
    const parsed = parseAnswer(rawAnswer, question, String(id))
    const minConfidence = resolveMinConfidence(question, defaultMinConfidence)
    answers[id] = (
      minConfidence !== undefined && parsed.confidence < minConfidence ? new Uncertain() : parsed.answer
    ) as AnswerOf<Q[typeof id]>
    probabilities[id] = parsed.probabilities
    confidence[id] = parsed.confidence
  }

  const usage = parseUsage(response['usage'])
  return { modelId, answers, probabilities, confidence, ...(usage !== undefined && { usage }) }
}

function parseAnswer(rawAnswer: unknown, question: Question, id: string): ParsedAnswer {
  const answer = requireRecord(rawAnswer, `answer for question id=<${id}>`)
  if (question.choices === 'boolean') return parseNoulAnswer(answer, id)
  return parseChoiceAnswer(answer, question.choices, id)
}

function parseNoulAnswer(answer: Record<string, unknown>, id: string): ParsedAnswer {
  if (answer['type'] !== 'noul') {
    throw new ModelError(`answer for boolean question id=<${id}> must have type 'noul'`)
  }
  const probability = requireProbability(answer['noul'], `noul for question id=<${id}>`)
  return {
    answer: probability >= 0.5,
    probabilities: { true: probability, false: 1 - probability },
    confidence: Math.abs(2 * probability - 1),
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
  if (Math.abs(sum - 1) > PROBABILITY_TOLERANCE) {
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
