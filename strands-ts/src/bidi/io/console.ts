/**
 * Console input and output for bidirectional conversations.
 *
 * Node-only: `node:readline` is imported lazily so the module stays importable in browsers.
 */

import type { BidiAgent } from '../agent/agent.js'
import type { BidiAgentInput } from '../types/agent.js'
import type { BidiOutputEvent } from '../types/events.js'
import type { BidiInputStream, BidiOutputStream } from '../types/io.js'
import type { ConsoleIOConfig } from './configs.js'

import { TextBlock } from '../../types/messages.js'

/** Resolved console configuration with every field defaulted. */
interface ResolvedConsoleIOConfig {
  placeholder: string
  showText: boolean
  showReasoning: boolean
  showTranscript: boolean
  showTools: boolean
}

/** Rendering style of one displayed content block. */
type DisplayBlockKind = 'user' | 'assistant' | 'reasoning' | 'tool'

/** One displayed content block and its completion state. */
interface DisplayBlock {
  kind: DisplayBlockKind
  text: string
  complete: boolean
}

/** The current keyboard draft or a message submitted by pressing Enter. */
interface KeyboardInput {
  text: string
  submitted: boolean
}

/** A keypress reported by `readline.emitKeypressEvents`. */
interface KeyPress {
  name?: string
  sequence?: string
  ctrl?: boolean
  meta?: boolean
}

/** Move up `lines` rows and erase everything below. */
function eraseLines(lines: number): string {
  return lines > 0 ? `\x1b[${lines}A\x1b[0J` : ''
}

/**
 * Render a block as the line the console prints for it.
 *
 * @param block - Block to render
 * @returns The rendered line
 */
function renderBlock(block: DisplayBlock): string {
  switch (block.kind) {
    case 'user':
      return `> ${block.text}`
    case 'reasoning':
      return `Reasoning: ${block.text.trimEnd()}`
    case 'tool':
      return `Tools: [${block.text}]`
    default:
      return block.text
  }
}

/**
 * Show active content and a draft while preserving completed text in terminal history.
 *
 * Completed blocks are written to stdout permanently. Unfinished blocks and the input draft are
 * redrawn in place on a terminal and omitted entirely when stdout is not a TTY.
 *
 * @internal
 */
export class Display {
  /** Active content blocks keyed by content id, in arrival order. */
  readonly blocks = new Map<string, DisplayBlock>()

  /** Unsubmitted keyboard text. */
  draft = ''

  /** Whether the display is rendering. */
  started = false

  private readonly _placeholder: string
  private _frameLines = 0

  /**
   * Initialize the terminal display and input placeholder.
   *
   * @param placeholder - Hint displayed when the input block is empty
   */
  constructor(placeholder: string) {
    this._placeholder = placeholder
  }

  /** Start rendering if the display is not already running. */
  start(): void {
    if (this.started) return

    this.started = true
    this._frameLines = 0
    this._draw()
  }

  /** Stop rendering and print remaining blocks, including unfinished content. */
  stop(): void {
    if (!this.started) return

    this.started = false
    this._erase()
    if (this.blocks.size > 0) {
      this._print([...this.blocks.values()])
      this.blocks.clear()
    }
    if (process.stdout.isTTY) process.stdout.write('\x1b[?25h')
  }

  /** Print completed blocks in order and redraw the remaining live content. */
  refresh(): void {
    if (!this.started) return

    const completed: DisplayBlock[] = []
    for (const [contentId, block] of this.blocks) {
      // Later blocks stay live until this block finishes.
      if (!block.complete) break
      this.blocks.delete(contentId)
      completed.push(block)
    }

    this._erase()
    if (completed.length > 0) this._print(completed)
    this._draw()
  }

  /** Write completed blocks to terminal history, skipping empty ones. */
  private _print(blocks: DisplayBlock[]): void {
    const lines = blocks.filter((block) => block.text).map((block) => `${renderBlock(block)}\n\n`)
    if (lines.length > 0) process.stdout.write(lines.join(''))
  }

  /** Erase the live frame drawn by the previous render. */
  private _erase(): void {
    if (this._frameLines > 0) process.stdout.write(eraseLines(this._frameLines))
    this._frameLines = 0
  }

  /** Draw unfinished blocks and the input block in the live frame. */
  private _draw(): void {
    if (!process.stdout.isTTY) return

    const lines = [...this.blocks.values()].filter((block) => block.text).map(renderBlock)
    lines.push(this.draft || !this._placeholder ? `> ${this.draft}\u258f` : `> ${this._placeholder}`)
    this._frameLines = lines.length
    process.stdout.write(`${lines.join('\n')}\n`)
  }
}

/**
 * Manage terminal input and retain unfinished drafts and pending keys.
 *
 * @internal
 */
export class Keyboard {
  private _text = ''
  private _keys: KeyPress[] = []
  private _closed = false
  private _ready: (() => void) | undefined
  private _detach: (() => void) | undefined

  /** Enable keyboard input. */
  async start(): Promise<void> {
    if (this._detach) return

    const readline = await import('node:readline')
    const stdin = process.stdin
    readline.emitKeypressEvents(stdin)

    const onKeypress = (_sequence: string, key: KeyPress): void => {
      this._keys.push(key)
      this._notify()
    }
    const onClose = (): void => {
      this._closed = true
      this._notify()
    }

    stdin.on('keypress', onKeypress)
    stdin.on('end', onClose)
    stdin.on('close', onClose)
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()

    this._detach = (): void => {
      stdin.off('keypress', onKeypress)
      stdin.off('end', onClose)
      stdin.off('close', onClose)
      if (stdin.isTTY) stdin.setRawMode(false)
      stdin.pause()
    }
  }

  /** Restore terminal settings and detach input notifications. */
  stop(): void {
    this._detach?.()
    this._detach = undefined
  }

  /**
   * Read draft text or a message submitted with Enter.
   *
   * @returns The submitted message or the current draft
   * @throws Error if the input source has closed and its pending keys are exhausted.
   */
  async read(): Promise<KeyboardInput> {
    while (this._keys.length === 0) {
      if (this._closed) throw new Error('terminal input closed')
      await new Promise<void>((resolve) => {
        this._ready = resolve
      })
    }

    while (this._keys.length > 0) {
      const key = this._keys.shift() as KeyPress
      if (key.name === 'return' || key.name === 'enter') {
        const message = this._text.trim()
        this._text = ''
        if (message) return { text: message, submitted: true }
      } else if (key.ctrl === true && key.name === 'c') {
        process.kill(process.pid, 'SIGINT')
      } else if (key.name === 'backspace') {
        this._text = this._text.slice(0, -1)
      } else if (key.ctrl !== true && key.meta !== true && key.sequence !== undefined && key.sequence >= ' ') {
        this._text += key.sequence
      }
    }

    return { text: this._text, submitted: false }
  }

  /** Wake a pending `read()`. */
  private _notify(): void {
    const ready = this._ready
    this._ready = undefined
    ready?.()
  }
}

/**
 * Read submitted messages while keeping the keyboard draft visible.
 *
 * @internal
 */
export class ConsoleInputStream implements BidiInputStream {
  private readonly _display: Display
  private readonly _keyboard: Keyboard

  /**
   * Share the console's display and keyboard reader.
   *
   * @param display - Terminal display shared with the output stream
   * @param keyboard - Keyboard reader for terminal input
   */
  constructor(display: Display, keyboard: Keyboard) {
    this._display = display
    this._keyboard = keyboard
  }

  /**
   * Enable terminal input and start the shared display.
   *
   * @param _agent - The agent that owns this stream
   */
  async start(_agent: BidiAgent): Promise<void> {
    await this._keyboard.start()
    this._display.start()
  }

  /** Restore terminal input settings and flush the display. */
  async stop(): Promise<void> {
    this._keyboard.stop()
    this._display.stop()
  }

  /**
   * Refresh the draft until Enter submits a nonempty message.
   *
   * @returns The submitted message
   * @throws Error if terminal input closes before another message is submitted.
   */
  async read(): Promise<BidiAgentInput> {
    for (;;) {
      const keyboardInput = await this._keyboard.read()
      if (keyboardInput.submitted) {
        this._display.draft = ''
        this._display.blocks.set(globalThis.crypto.randomUUID(), {
          kind: 'user',
          text: keyboardInput.text,
          complete: true,
        })
        this._display.refresh()
        return new TextBlock(keyboardInput.text)
      }

      this._display.draft = keyboardInput.text
      this._display.refresh()
    }
  }
}

/**
 * Display enabled text, reasoning, transcript, and tool call output.
 *
 * @internal
 */
export class ConsoleOutputStream implements BidiOutputStream {
  private readonly _config: ResolvedConsoleIOConfig
  private readonly _display: Display

  /**
   * Share the configured content filters and terminal display.
   *
   * @param config - Resolved console configuration
   * @param display - Terminal display shared with the input stream
   */
  constructor(config: ResolvedConsoleIOConfig, display: Display) {
    this._config = config
    this._display = display
  }

  /**
   * Start the shared display.
   *
   * @param _agent - The agent that owns this stream
   */
  async start(_agent: BidiAgent): Promise<void> {
    this._display.start()
  }

  /** Flush remaining content and close the shared display. */
  async stop(): Promise<void> {
    this._display.stop()
  }

  /**
   * Apply a content stream event and refresh the display.
   *
   * @param event - Output event from the agent
   */
  async write(event: BidiOutputEvent): Promise<void> {
    switch (event.type) {
      case 'bidiTextStart':
        if (!this._config.showText) return
        this._display.blocks.set(event.contentId, { kind: 'assistant', text: '', complete: false })
        break

      case 'bidiReasoningStart':
        if (!this._config.showReasoning) return
        this._display.blocks.set(event.contentId, { kind: 'reasoning', text: '', complete: false })
        break

      case 'bidiTranscriptStart': {
        if (!this._config.showTranscript) return
        const kind = event.role === 'user' ? 'user' : 'assistant'
        this._display.blocks.set(event.contentId, { kind, text: '', complete: false })
        break
      }

      case 'bidiToolUseBlocks': {
        if (!this._config.showTools) return
        const [first] = event.toolUses
        if (first === undefined) return
        const names = event.toolUses.map((toolUse) => toolUse.name).join(', ')
        this._display.blocks.set(first.toolUseId, { kind: 'tool', text: names, complete: true })
        break
      }

      case 'bidiTextDelta':
      case 'bidiReasoningDelta':
      case 'bidiTranscriptDelta': {
        const block = this._display.blocks.get(event.contentId)
        if (block === undefined) return
        block.text += event.delta
        break
      }

      case 'bidiTextStop':
      case 'bidiReasoningStop':
      case 'bidiTranscriptStop': {
        const block = this._display.blocks.get(event.contentId)
        if (block === undefined) return
        block.complete = true
        break
      }

      case 'bidiConnectionRestart':
      case 'bidiConnectionStop':
        for (const block of this._display.blocks.values()) {
          block.complete = true
        }
        break

      default:
        return
    }

    this._display.refresh()
  }
}

/**
 * Type messages while displaying text, reasoning, speech transcripts, and tool calls.
 *
 * Input and output share a terminal display, so streamed content preserves the unfinished input
 * line. Enter sends a message.
 *
 * @example
 * ```ts
 * const io = new ConsoleIO({ placeholder: 'Type a message' })
 * const agent = new BidiAgent({ model })
 * await agent.run({ inputs: [io.input()], outputs: [io.output()] })
 * ```
 */
export class ConsoleIO {
  private readonly _config: ResolvedConsoleIOConfig
  private readonly _display: Display
  private readonly _keyboard: Keyboard

  /**
   * Initialize the console.
   *
   * @param config - Optional configuration:
   *
   * - placeholder: Hint displayed when the input block is empty (default: "").
   * - showText: Display agent text responses (default: true).
   * - showReasoning: Display agent reasoning (default: true).
   * - showTranscript: Display user and agent speech transcripts (default: true).
   * - showTools: Display tool call names (default: true).
   */
  constructor(config: ConsoleIOConfig = {}) {
    this._config = {
      placeholder: config.placeholder ?? '',
      showText: config.showText ?? true,
      showReasoning: config.showReasoning ?? true,
      showTranscript: config.showTranscript ?? true,
      showTools: config.showTools ?? true,
    }
    this._display = new Display(this._config.placeholder)
    this._keyboard = new Keyboard()
  }

  /**
   * Return the keyboard input stream.
   *
   * @returns Input stream that reads typed messages
   */
  input(): BidiInputStream {
    return new ConsoleInputStream(this._display, this._keyboard)
  }

  /**
   * Return the text, reasoning, transcript, and tool call output stream.
   *
   * @returns Output stream that renders content to the terminal
   */
  output(): BidiOutputStream {
    return new ConsoleOutputStream(this._config, this._display)
  }
}

export type { ConsoleIOConfig } from './configs.js'
