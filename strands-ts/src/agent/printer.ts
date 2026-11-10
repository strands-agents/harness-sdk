import type { AgentStreamEvent } from '../types/agent.js'
import type {
  ModelStreamEvent,
  ModelContentBlockDeltaEventData,
  ModelContentBlockStartEventData,
} from '../models/streaming.js'
import type { BeforeToolCallEvent, BeforeToolsEvent, ToolResultEvent } from '../hooks/events.js'

/**
 * Creates a default appender function for the current environment.
 * Uses process.stdout.write in Node.js and console.log in browsers.
 * @returns Appender function that writes text to the output destination
 */
export function getDefaultAppender(): (text: string) => void {
  // Check if we're in Node.js environment with stdout
  if (typeof process !== 'undefined' && process.stdout?.write) {
    return (text: string) => process.stdout.write(text)
  }
  // Fall back to console.log for browser environment
  return (text: string) => console.log(text)
}

/**
 * Interface for printing agent activity to a destination.
 * Implementations can output to stdout, console, HTML elements, etc.
 */
export interface Printer {
  /**
   * Write content to the output destination.
   * @param content - The content to write
   */
  write(content: string): void

  /**
   * Process a streaming event from the agent.
   * @param event - The event to process
   */
  processEvent(event: AgentStreamEvent): void
}

/**
 * Default implementation of the Printer interface.
 * Outputs text, reasoning, and tool execution activity to the configured appender.
 */
export class AgentPrinter implements Printer {
  private readonly _appender: (text: string) => void
  private _inReasoningBlock: boolean = false
  private _toolCount: number = 0
  private _needReasoningIndent: boolean = false

  /**
   * Creates a new AgentPrinter.
   * @param appender - Function that writes text to the output destination
   */
  constructor(appender: (text: string) => void) {
    this._appender = appender
  }

  /**
   * Write content to the output destination.
   * @param content - The content to write
   */
  public write(content: string): void {
    this._appender(content)
  }

  /**
   * Process a streaming event from the agent.
   * Handles text deltas, reasoning content, and tool execution events.
   * @param event - The event to process
   */
  public processEvent(event: AgentStreamEvent): void {
    switch (event.type) {
      case 'modelStreamUpdateEvent':
        this.handleModelStreamEvent(event.event)
        break

      case 'beforeToolCallEvent':
        this.handleBeforeToolCall(event)
        break

      case 'beforeToolsEvent':
        this.handleBeforeTools(event)
        break

      case 'toolResultEvent':
        this.handleToolResult(event)
        break

      case 'agentResultEvent':
        this.write('\n')
        break

      // Ignore other event types
      default:
        break
    }
  }

  /**
   * Handle raw model stream events unwrapped from ModelStreamUpdateEvent.
   */
  private handleModelStreamEvent(event: ModelStreamEvent): void {
    switch (event.type) {
      case 'modelContentBlockDeltaEvent':
        this.handleContentBlockDelta(event)
        break
      case 'modelContentBlockStartEvent':
        this.handleContentBlockStart(event)
        break
      case 'modelContentBlockStopEvent':
        this.handleContentBlockStop()
        break
      default:
        break
    }
  }

  /**
   * Handle content block delta events (text or reasoning).
   */
  private handleContentBlockDelta(event: ModelContentBlockDeltaEventData): void {
    const { delta } = event

    if (delta.type === 'textDelta') {
      // Output text immediately
      if (delta.text && delta.text.length > 0) {
        this.write(delta.text)
      }
    } else if (delta.type === 'reasoningContentDelta') {
      // Start reasoning block if not already in one
      if (!this._inReasoningBlock) {
        this._inReasoningBlock = true
        this._needReasoningIndent = true
        this.write('\n💭 Reasoning:\n')
      }

      // Stream reasoning text with proper indentation
      if (delta.text && delta.text.length > 0) {
        this.writeReasoningText(delta.text)
      }
    }
    // Ignore toolUseInputDelta and other delta types
  }

  /**
   * Write reasoning text with proper indentation after newlines.
   */
  private writeReasoningText(text: string): void {
    let output = ''

    for (let i = 0; i < text.length; i++) {
      const char = text[i]

      // Add indentation if needed (at start or after newline)
      if (this._needReasoningIndent && char !== '\n') {
        output += '   '
        this._needReasoningIndent = false
      }

      output += char

      // Mark that we need indentation after a newline
      if (char === '\n') {
        this._needReasoningIndent = true
      }
    }

    this.write(output)
  }

  /**
   * Handle content block start events.
   * Prints a subtle preview during streaming; the definitive announcement
   * (with numbering and status icon) comes in beforeToolCallEvent after hooks resolve.
   */
  private handleContentBlockStart(event: ModelContentBlockStartEventData): void {
    if (event.start?.type === 'toolUseStart') {
      this.write(`\n  ⏳ ${event.start.name}\n`)
    }
  }

  /**
   * Handle content block stop events.
   * Closes reasoning blocks if we were in one.
   */
  private handleContentBlockStop(): void {
    if (this._inReasoningBlock) {
      // End reasoning block with a newline if we didn't just write one
      if (!this._needReasoningIndent) {
        this.write('\n')
      }
      this._inReasoningBlock = false
      this._needReasoningIndent = false
    }
  }

  /**
   * Handle before-tool-call events.
   * Announces the tool after hooks have resolved, so denied tools get a
   * distinct indicator instead of looking like they executed.
   */
  private handleBeforeToolCall(event: BeforeToolCallEvent): void {
    this._toolCount++
    if (event.cancel) {
      this.write(`\n🚫 Tool #${this._toolCount}: ${event.toolUse.name} (denied)\n`)
    } else {
      this.write(`\n🔧 Tool #${this._toolCount}: ${event.toolUse.name}\n`)
    }
  }

  /**
   * Handle before-tools events.
   * When all tools are batch-cancelled, prints a notice since no individual
   * BeforeToolCallEvent will fire.
   */
  private handleBeforeTools(event: BeforeToolsEvent): void {
    if (event.cancel) {
      this.write('\n🚫 All tools denied\n')
    }
  }

  /**
   * Handle tool result events.
   * Outputs completion status.
   */
  private handleToolResult(event: ToolResultEvent): void {
    if (event.result.status === 'success') {
      this.write('✓ Tool completed\n')
    } else if (event.result.status === 'error') {
      this.write('✗ Tool failed\n')
    }
  }
}
