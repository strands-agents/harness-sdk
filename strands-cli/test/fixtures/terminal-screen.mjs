import headless from '@xterm/headless'
import { Buffer } from 'node:buffer'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import stringWidth from 'string-width'

export class TerminalScreen {
  constructor(columns, rows) {
    this.terminal = new headless.Terminal({ cols: columns, rows, allowProposedApi: true })
  }

  async write(data) {
    await new Promise((resolve) => this.terminal.write(data, resolve))
  }

  resize(columns, rows) {
    this.terminal.resize(columns, rows)
  }

  get text() {
    const buffer = this.terminal.buffer.active
    return Array.from({ length: this.terminal.rows }, (_, row) =>
      buffer.getLine(buffer.viewportY + row)?.translateToString(true)
    ).join('\n')
  }

  locate(text) {
    const lines = this.text.split('\n')
    const row = lines.findIndex((line) => line.includes(text))
    if (row < 0) return undefined
    const column = stringWidth(lines[row].slice(0, lines[row].indexOf(text)))
    const cell = this.terminal.buffer.active.getLine(this.terminal.buffer.active.viewportY + row).getCell(column)
    return {
      column: column + 1,
      row: row + 1,
      style: [cell.getFgColorMode(), cell.getFgColor(), cell.isBold(), cell.isDim()],
    }
  }

  dispose() {
    this.terminal.dispose()
  }
}

// The POSIX driver owns termios; both drivers use the same terminal parser.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const screen = new TerminalScreen(Number(process.argv[2]), Number(process.argv[3]))
  try {
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line)
      if (request.columns !== undefined) screen.resize(request.columns, request.rows)
      if (request.data) await screen.write(Buffer.from(request.data, 'base64'))
      process.stdout.write(
        `${JSON.stringify({ text: screen.text, target: request.target ? screen.locate(request.target) : undefined })}\n`
      )
    }
  } finally {
    screen.dispose()
  }
}
