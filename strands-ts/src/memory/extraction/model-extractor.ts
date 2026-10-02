import { Message, TextBlock, type MessageData } from '../../types/messages.js'
import type { Model } from '../../models/model.js'
import { ModelProxy } from '../../models/model-proxy.js'
import type { JSONValue } from '../../types/json.js'
import { logger } from '../../logging/logger.js'
import { normalizeError } from '../../errors.js'
import type { ExtractionResult, Extractor, ExtractorContext } from './types.js'

/** Default instruction guiding the model to emit discrete, durable facts as a JSON array. */
const DEFAULT_SYSTEM_PROMPT = `You extract durable facts worth remembering across future conversations from a transcript.

Return ONLY a JSON array of objects, each: {"content": string}. Each object is one discrete, self-contained fact (a preference, decision, or stable detail about the user or task). Do not include transient chit-chat, questions, or anything already obvious. If there is nothing worth remembering, return [].`

/** Options for {@link ModelExtractor}. */
export interface ModelExtractorOptions {
  /** Model used to extract facts. Defaults to the agent's own model; set a cheaper one to cut cost. */
  model?: Model
  /** System prompt steering what counts as a fact. Defaults to a general fact-extraction prompt. */
  systemPrompt?: string
}

/**
 * An {@link Extractor} that calls a language model to distill messages into discrete facts.
 *
 * Use for self-managed stores that hold plain text and want automatic distillation. Backends that
 * extract server-side should omit the extractor entirely (the no-extractor passthrough hands them
 * raw messages instead).
 *
 * @example
 * ```typescript
 * extraction: {
 *   trigger: [new InvocationTrigger()],
 *   extractor: new ModelExtractor({ model: cheapModel, systemPrompt: 'Extract user preferences.' }),
 * }
 * ```
 */
export class ModelExtractor implements Extractor {
  private readonly _model?: Model
  private readonly _systemPrompt: string

  constructor(options: ModelExtractorOptions = {}) {
    if (options.model !== undefined) {
      this._model = options.model
    }
    this._systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  }

  async extract(messages: MessageData[], context?: ExtractorContext): Promise<ExtractionResult[]> {
    const model = this._model ?? context?.defaultModel
    if (!model) {
      throw new Error('ModelExtractor: no model configured and no default model available')
    }
    if (messages.length === 0) {
      return []
    }

    // Present the transcript as a single user turn so the system prompt governs extraction, rather
    // than feeding raw roles the model might try to continue.
    const transcript = messages.map((message) => _renderMessage(message)).join('\n')
    const promptMessages = [
      new Message({
        role: 'user',
        content: [new TextBlock(`Extract facts from the following transcript:\n\n${transcript}`)],
      }),
    ]

    const span =
      context?.tracer?.startModelInvokeSpan({
        messages: promptMessages,
        ...(model.modelId !== undefined && { modelId: model.modelId }),
        systemPrompt: this._systemPrompt,
      }) ?? null

    let result: Awaited<ReturnType<ReturnType<typeof model.streamAggregated>['next']>> | undefined
    try {
      // Wrap in a ModelProxy so this extraction's tokens fold into the enclosing request's
      // usage total when a trigger captured its invocation.
      const proxy = new ModelProxy(model)
      const stream = proxy.streamAggregated(promptMessages, { systemPrompt: this._systemPrompt }, context?.invocation)
      // Manual .next() loop: streamAggregated returns its result as the generator return value
      // (done:true), which for-await-of discards.
      for (;;) {
        result = await stream.next()
        if (result.done) break
      }
    } catch (error) {
      context?.tracer?.endModelInvokeSpan(span, { error: normalizeError(error) })
      throw error
    }

    if (!result?.done || !result.value) {
      const noResponseError = new Error('ModelExtractor: model returned no response')
      context?.tracer?.endModelInvokeSpan(span, { error: noResponseError })
      throw noResponseError
    }

    const { message, stopReason, metadata } = result.value
    context?.tracer?.endModelInvokeSpan(span, {
      output: message,
      stopReason,
      ...(metadata?.usage !== undefined && { usage: metadata.usage }),
      ...(metadata?.metrics !== undefined && { metrics: metadata.metrics }),
    })

    const text = message.content
      .map((block) => ('text' in block ? block.text : ''))
      .join('')
      .trim()

    return _parseEntries(text, model.constructor.name)
  }
}

/** Renders one message as `role: text`, joining its text blocks. */
function _renderMessage(message: MessageData): string {
  const text = message.content
    .map((block) => ('text' in block ? block.text : ''))
    .filter((part) => part.length > 0)
    .join('\n')
  return `${message.role}: ${text}`
}

/**
 * Parses the model's response into entries. Tolerates the array being wrapped in prose or a fenced
 * code block by extracting the first top-level bracketed array. Malformed output yields no entries
 * (logged) rather than throwing, so a single bad extraction never breaks the agent loop.
 */
function _parseEntries(text: string, modelName: string): ExtractionResult[] {
  const json = _extractJsonArray(text)
  if (json === undefined) {
    logger.warn(`model=<${modelName}> | ModelExtractor: no JSON array in model output, skipping`)
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (err) {
    logger.warn(`model=<${modelName}>, error=<${String(err)}> | ModelExtractor: failed to parse output`)
    return []
  }

  if (!Array.isArray(parsed)) {
    return []
  }

  const entries: ExtractionResult[] = []
  for (const item of parsed) {
    if (item && typeof item === 'object' && typeof (item as { content?: unknown }).content === 'string') {
      const record = item as { content: string; metadata?: Record<string, JSONValue> }
      const content = record.content.trim()
      if (content.length > 0) {
        entries.push({ content, ...(record.metadata !== undefined && { metadata: record.metadata }) })
      }
    }
  }
  return entries
}

/** Extracts the substring from the first `[` to the last `]`, or undefined if absent. */
function _extractJsonArray(text: string): string | undefined {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) {
    return undefined
  }
  return text.slice(start, end + 1)
}
