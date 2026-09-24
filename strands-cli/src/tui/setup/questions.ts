import { tool, type AgentStreamEvent, type Tool } from '@strands-agents/sdk'

import { sanitizeTerminalText } from '../terminal/sanitize.js'

export interface SetupQuestionChoice {
  id: string
  label: string
  custom?: boolean
}

export interface SetupQuestionRequest {
  id: string
  question: string
  choices: readonly SetupQuestionChoice[]
}

type QuestionListener = (request: SetupQuestionRequest | undefined) => void

interface PendingQuestion {
  request: SetupQuestionRequest
  resolve: (choice: SetupQuestionChoice) => void
  reject: (error: Error) => void
}

export class SetupQuestionBroker {
  private readonly listeners = new Set<QuestionListener>()
  private active: PendingQuestion | undefined
  private nextRequest = 1
  private disposed = false

  request(question: string, choices: readonly { label: string }[], signal?: AbortSignal): Promise<SetupQuestionChoice> {
    if (this.disposed) {
      return Promise.reject(new Error('Setup questions are no longer available.'))
    }
    if (this.active) {
      return Promise.reject(new Error('Finish the current setup question before asking another.'))
    }
    if (choices.length < 2 || choices.length > 10) {
      return Promise.reject(new Error('Setup questions require between 2 and 10 choices.'))
    }
    if (signal?.aborted) {
      return Promise.reject(new Error('Setup question cancelled.'))
    }

    const request: SetupQuestionRequest = {
      id: `setup-question-${this.nextRequest++}`,
      question: requiredText(question, 'question', 400),
      choices: choices.map((choice, index) => {
        const label = requiredText(choice.label, `choices[${index}].label`, 48)
        if (/^(?:custom|something else)$/iu.test(label)) {
          throw new Error('Use the normal message input for custom setup answers.')
        }
        return {
          id: String(index),
          label,
        }
      }),
    }

    return new Promise((resolve, reject) => {
      const cancel = (): void => this.cancel(request.id)
      signal?.addEventListener('abort', cancel, { once: true })
      const cleanup = (): void => signal?.removeEventListener('abort', cancel)
      this.active = {
        request,
        resolve: (choice): void => {
          cleanup()
          resolve(choice)
        },
        reject: (error): void => {
          cleanup()
          reject(error)
        },
      }
      this.notify(request)
    })
  }

  respond(requestId: string, choiceId: string): boolean {
    const pending = this.active
    const choice = pending?.request.choices.find((candidate) => candidate.id === choiceId)
    if (!pending || pending.request.id !== requestId || !choice) {
      return false
    }
    this.active = undefined
    pending.resolve({ ...choice })
    this.notify(undefined)
    return true
  }

  respondText(requestId: string, text: string): boolean {
    const pending = this.active
    if (!pending || pending.request.id !== requestId) {
      return false
    }
    const answer = requiredText(text, 'answer', 2_000)
    this.active = undefined
    pending.resolve({ id: 'custom', label: answer, custom: true })
    this.notify(undefined)
    return true
  }

  subscribe(listener: QuestionListener): () => void {
    this.listeners.add(listener)
    if (this.active) {
      listener(cloneRequest(this.active.request))
    }
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    const pending = this.active
    this.active = undefined
    pending?.reject(new Error('Setup question cancelled.'))
    this.notify(undefined)
    this.listeners.clear()
  }

  private cancel(requestId: string): void {
    const pending = this.active
    if (!pending || pending.request.id !== requestId) {
      return
    }
    this.active = undefined
    pending.reject(new Error('Setup question cancelled.'))
    this.notify(undefined)
  }

  private notify(request: SetupQuestionRequest | undefined): void {
    for (const listener of this.listeners) {
      listener(request ? cloneRequest(request) : undefined)
    }
  }
}

export function createSetupQuestionTool(broker: SetupQuestionBroker): Tool {
  return tool({
    name: 'setup_question',
    description:
      'Ask one concise setup question through the interactive frog UI and wait for the user to choose or type an answer. ' +
      'Before calling this tool, emit the exact question once as normal assistant text so it streams live; pass that same text in question. ' +
      'Use 2-10 choices for closed-ended decisions. The user can always type a different answer. ' +
      'Do not add generic Custom or Something else choices; free-form answers use the normal message input.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          maxLength: 400,
          description: 'The exact question already emitted as normal assistant text.',
        },
        choices: {
          type: 'array',
          minItems: 2,
          maxItems: 10,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', maxLength: 48 },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
      },
      required: ['question', 'choices'],
      additionalProperties: false,
    },
    callback: async (input, context) => {
      const request = questionInput(input)
      const selected = await broker.request(request.question, request.choices, context?.cancelSignal)
      return selected.custom
        ? JSON.stringify({
            answer: selected.label,
            custom: true,
            next: 'Briefly acknowledge this answer before asking the next question.',
          })
        : JSON.stringify({ selected: selected.label, index: Number(selected.id) })
    },
  })
}

export class SetupQuestionTextStream {
  private assistantText = ''
  private toolInput = ''
  private streamedLength = 0
  private active = false

  project(event: AgentStreamEvent): string {
    if (event.type !== 'modelStreamUpdateEvent') {
      return ''
    }
    const inner = event.event
    if (inner.type === 'modelMessageStartEvent') {
      this.assistantText = ''
      this.resetTool()
      return ''
    }
    if (inner.type === 'modelContentBlockStartEvent') {
      this.active = inner.start?.type === 'toolUseStart' && inner.start.name === 'setup_question'
      this.toolInput = ''
      this.streamedLength = 0
      return ''
    }
    if (inner.type === 'modelContentBlockStopEvent') {
      this.resetTool()
      return ''
    }
    if (inner.type !== 'modelContentBlockDeltaEvent') {
      return ''
    }
    if (inner.delta.type === 'textDelta') {
      this.assistantText += inner.delta.text
      return ''
    }
    if (!this.active || inner.delta.type !== 'toolUseInputDelta') {
      return ''
    }

    this.toolInput += inner.delta.input
    const question = partialJsonString(this.toolInput, 'question')
    if (this.streamedLength === 0 && this.assistantText.includes(question)) {
      return ''
    }
    const separator = this.streamedLength === 0 && this.assistantText.trim() ? '\n\n' : ''
    const delta = question.slice(this.streamedLength)
    this.streamedLength = question.length
    return sanitizeTerminalText(separator + delta)
  }

  private resetTool(): void {
    this.active = false
    this.toolInput = ''
    this.streamedLength = 0
  }
}

function questionInput(value: unknown): {
  question: string
  choices: { label: string }[]
} {
  if (!isRecord(value) || typeof value.question !== 'string' || !Array.isArray(value.choices)) {
    throw new Error('Invalid setup question.')
  }
  const choices = value.choices.map((choice, index) => {
    if (!isRecord(choice) || typeof choice.label !== 'string') {
      throw new Error(`Invalid setup question choice at index ${index}.`)
    }
    return { label: choice.label }
  })
  return { question: value.question, choices }
}

function partialJsonString(input: string, property: string): string {
  const match = new RegExp(`"${property}"\\s*:\\s*"`).exec(input)
  if (!match) {
    return ''
  }
  const start = match.index + match[0].length
  let raw = ''
  for (let index = start; index < input.length; index++) {
    const character = input[index]!
    if (character === '"') {
      break
    }
    if (character !== '\\') {
      if (character < ' ') {
        break
      }
      raw += character
      continue
    }

    const escape = input[index + 1]
    if (!escape) {
      break
    }
    if (escape === 'u') {
      const unicode = input.slice(index + 2, index + 6)
      if (!/^[\da-f]{4}$/iu.test(unicode)) {
        break
      }
      raw += `\\u${unicode}`
      index += 5
      continue
    }
    if (!/["\\/bfnrt]/u.test(escape)) {
      break
    }
    raw += `\\${escape}`
    index++
  }
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return ''
  }
}

function requiredText(value: string, name: string, maximum: number): string {
  const text = sanitizeTerminalText(value).trim()
  if (!text) {
    throw new Error(`${name} must not be empty.`)
  }
  if ([...text].length > maximum) {
    throw new Error(`${name} must be at most ${maximum} characters.`)
  }
  return text
}

function cloneRequest(request: SetupQuestionRequest): SetupQuestionRequest {
  return {
    ...request,
    choices: request.choices.map((choice) => ({ ...choice })),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
