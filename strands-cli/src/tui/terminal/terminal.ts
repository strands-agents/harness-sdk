import { spawn } from 'node:child_process'

const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h\u001b[2J\u001b[H'
const RESET_KITTY_KEYBOARD = '\u001b[<u'.repeat(16)
const ENABLE_MOUSE = '\u001b[?1002h\u001b[?1006h'
const ENABLE_MOUSE_MOTION = '\u001b[?1002l\u001b[?1003h'
const ENABLE_MOUSE_CLICKS = '\u001b[?1003l\u001b[?1002h'
const DISABLE_MOUSE = '\u001b[?1006l\u001b[?1003l\u001b[?1002l'
const LEAVE_ALTERNATE_SCREEN = `${DISABLE_MOUSE}\u001b[?25h\u001b[?1049l\u001b[?25h`

export interface TerminalOutput {
  isTTY?: boolean
  write(value: string): unknown
}

export function enterAlternateScreen(output: TerminalOutput = process.stdout): () => void {
  let active = true
  output.write(`${RESET_KITTY_KEYBOARD}${ENTER_ALTERNATE_SCREEN}${ENABLE_MOUSE}`)

  return (): void => {
    if (!active) {
      return
    }
    active = false
    output.write(LEAVE_ALTERNATE_SCREEN)
  }
}

export function setTerminalMouseMotion(enabled: boolean, output: TerminalOutput = process.stdout): void {
  output.write(enabled ? ENABLE_MOUSE_MOTION : ENABLE_MOUSE_CLICKS)
}

export function copyTerminalText(text: string, output: TerminalOutput = process.stdout): Promise<boolean> {
  if (!text) {
    return Promise.resolve(false)
  }
  output.write(`\u001b]52;c;${Buffer.from(text).toString('base64')}\u001b\\`)
  if (process.platform !== 'darwin' || !output.isTTY) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const clipboard = spawn('pbcopy', { stdio: ['pipe', 'ignore', 'ignore'] })
    clipboard.once('error', () => resolve(false))
    clipboard.once('close', (code) => resolve(code === 0))
    clipboard.stdin.once('error', () => resolve(false))
    clipboard.stdin.end(text)
  })
}
