import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'
import {
  TextBlock,
  type Agent,
  type AgentResult,
  type AgentStreamEvent,
  type ToolResultContent,
  type Usage,
} from '@strands-agents/sdk'
import type { ChatEvent } from './tui/chat/types.js'
import { sanitizeTerminalText } from './tui/terminal/sanitize.js'
import { normalizeUsage, RunUsage, type NormalizedUsage } from './usage.js'

const EXIT_WORDS = new Set(['exit', 'quit'])
const SPINNER_FRAMES = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'
const CLEAR_LINE = '\r\x1b[K'

const MAX_TOOL_INPUT = 80
const STYLED = stdout.isTTY === true

function style(text: string, code: string): string {
  return STYLED ? `${code}${text}${RESET}` : text
}

function summarizeToolInput(toolInput: unknown): string {
  const text = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput ?? '')
  const clean = sanitizeTerminalText(text)
  return clean.length <= MAX_TOOL_INPUT ? clean : clean.slice(0, MAX_TOOL_INPUT - 1) + '…'
}

/**
 * Renders one agent turn's stream events, tracking which section is active.
 *
 * Reasoning and answer text stream under their own headers; tool calls and results print as
 * dim one-liners. A spinner covers the wait before the first renderable event.
 */
export class TurnRenderer {
  private section: 'thinking' | 'answer' | null = null

  constructor(private readonly model: Agent['model'] | undefined = undefined) {}

  /** Whether this event produces visible output (vs. a lifecycle/no-op event). */
  static renders(event: AgentStreamEvent): boolean {
    if (event.type === 'modelStreamUpdateEvent') {
      const inner = event.event
      if (inner.type === 'modelContentBlockDeltaEvent') {
        return inner.delta.type === 'textDelta' || inner.delta.type === 'reasoningContentDelta'
      }
      return inner.type === 'modelContentBlockStartEvent' && inner.start?.type === 'toolUseStart'
    }
    return event.type === 'beforeToolCallEvent' || event.type === 'toolResultEvent'
  }

  private switchTo(section: 'thinking' | 'answer', header: string): void {
    if (this.section === section) {
      return
    }
    if (this.section !== null) {
      stdout.write(STYLED ? `${RESET}\n` : '\n')
    }
    stdout.write(header)
    this.section = section
  }

  private breakStream(): void {
    if (this.section !== null) {
      stdout.write(STYLED ? `${RESET}\n` : '\n')
      this.section = null
    }
  }

  handle(event: AgentStreamEvent): void {
    if (event.type === 'modelStreamUpdateEvent') {
      const inner = event.event
      if (inner.type === 'modelContentBlockDeltaEvent') {
        if (inner.delta.type === 'reasoningContentDelta') {
          if (inner.delta.text) {
            this.switchTo('thinking', STYLED ? DIM + 'thinking > ' : 'thinking > ')
            stdout.write(sanitizeTerminalText(inner.delta.text))
          }
        } else if (inner.delta.type === 'textDelta') {
          if (inner.delta.text) {
            this.switchTo('answer', style('agent >', CYAN) + ' ')
            stdout.write(sanitizeTerminalText(inner.delta.text))
          }
        }
      }
      return
    }
    if (event.type === 'beforeToolCallEvent') {
      this.printToolCall(event.toolUse.name, event.toolUse.input)
    } else if (event.type === 'toolResultEvent') {
      this.printToolResult(event.result.status, event.result.content, event.result.error?.message)
    }
  }

  handleChat(event: ChatEvent): void {
    if (event.type === 'textDelta' || event.type === 'reasoningDelta') {
      this.switchTo(
        event.type === 'textDelta' ? 'answer' : 'thinking',
        event.type === 'textDelta' ? style('agent >', CYAN) + ' ' : 'thinking > '
      )
      stdout.write(sanitizeTerminalText(event.text))
    } else if (event.type === 'toolStart') {
      this.printToolCall(event.name, event.input)
    } else if (event.type === 'toolResult') {
      this.printToolResult(
        event.status,
        event.content.map(
          (block) =>
            new TextBlock(
              block.type === 'text'
                ? block.text
                : block.type === 'json'
                  ? JSON.stringify(block.value)
                  : `[${block.type}]`
            )
        ),
        event.error
      )
    }
  }

  private printToolCall(name: string, input: unknown): void {
    this.breakStream()
    const args = summarizeToolInput(input)
    stdout.write(style(`⚙ ${sanitizeTerminalText(name)}(${args})`, DIM) + '\n')
  }

  private printToolResult(
    status: 'success' | 'error',
    content: readonly ToolResultContent[] = [],
    error?: string
  ): void {
    this.breakStream()
    if (status === 'error') {
      const detail = error ? `: ${sanitizeTerminalText(error)}` : ''
      stdout.write(`${style('✗', RED)} ${style(`error${detail}`, DIM)}\n`)
      return
    }
    const result = summarizeToolResult(content)
    stdout.write(result ? `${style('↳', DIM)} ${result}\n` : `${style('✓', GREEN)} ${style('done', DIM)}\n`)
  }

  finish(
    result:
      | {
          metrics?: {
            latestAgentInvocation?: { usage: Usage } | undefined
            accumulatedUsage?: Usage
          }
        }
      | undefined,
    runUsage?: NormalizedUsage
  ): void {
    this.breakStream()
    const reportedUsage = result?.metrics?.latestAgentInvocation?.usage ?? result?.metrics?.accumulatedUsage
    const usage = runUsage ?? (reportedUsage ? normalizeUsage(this.model, reportedUsage) : undefined)
    if (usage) {
      const parts: string[] = []
      if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
        parts.push(`${usage.inputTokens} in`, `${usage.outputTokens} out`)
      } else {
        parts.push('input/output split unavailable')
      }
      const cacheRead = usage.cacheReadInputTokens ?? 0
      const cacheWrite = usage.cacheWriteInputTokens ?? 0
      if (cacheRead > 0 || cacheWrite > 0) {
        parts.push(`${cacheRead + cacheWrite} cached: ${cacheWrite}w ${cacheRead}r`)
      }
      const pending = usage.incomplete ? ' so far; background usage incomplete' : ''
      stdout.write(style(`${usage.totalTokens} tokens${pending}  (${parts.join(' / ')})`, DIM) + '\n')
    }
    stdout.write('\n')
  }
}

function summarizeToolResult(content: readonly ToolResultContent[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case 'textBlock':
          return block.text
        case 'jsonBlock':
          return JSON.stringify(block.json)
        case 'imageBlock':
          return `[image: ${block.format}]`
        case 'videoBlock':
          return `[video: ${block.format}]`
        case 'documentBlock':
          return `[document: ${block.name}.${block.format}]`
      }
    })
    .map(sanitizeTerminalText)
    .filter(Boolean)
    .join('\n')
}

async function spin(signal: { stopped: boolean }): Promise<void> {
  if (!STYLED) {
    return
  }
  let i = 0
  while (!signal.stopped) {
    stdout.write(`\r${SPINNER_FRAMES[i % SPINNER_FRAMES.length]} thinking… `)
    i++
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  stdout.write(CLEAR_LINE)
}

export async function runTurn(agent: Agent, message: string): Promise<void> {
  const renderer = new TurnRenderer(agent.model)
  const runUsage = RunUsage.start(agent)
  const signal = { stopped: false }
  const spinner = spin(signal)
  let result: AgentResult | undefined

  try {
    const stream = agent.stream(message)
    let next = await stream.next()
    while (!next.done) {
      const event = next.value
      if (TurnRenderer.renders(event)) {
        if (!signal.stopped) {
          signal.stopped = true
          await spinner // clears the spinner line before any output
        }
        renderer.handle(event)
      }
      next = await stream.next()
    }
    result = next.value
  } finally {
    if (!signal.stopped) {
      signal.stopped = true
      await spinner
    }
    renderer.finish(result, runUsage.total())
  }
}

export async function runPlainChat(
  agent: Agent,
  firstRequest: string | undefined,
  prompt?: { question(query: string): Promise<string>; close(): void }
): Promise<void> {
  const rl = prompt ?? createInterface({ input: stdin, output: stdout })
  stdout.write("Strands harness: type a message, or 'exit' to quit.\n\n")
  try {
    if (firstRequest) {
      stdout.write(`you > ${firstRequest}\n`)
      await runTurn(agent, firstRequest)
    }
    for (;;) {
      let line: string
      try {
        line = (await rl.question('you > ')).trim()
      } catch {
        stdout.write('\n')
        break
      }
      if (!line) {
        continue
      }
      if (EXIT_WORDS.has(line.toLowerCase())) {
        break
      }
      await runTurn(agent, line)
    }
  } finally {
    rl.close()
  }
}
