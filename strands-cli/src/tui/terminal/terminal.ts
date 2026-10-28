import { spawn } from 'node:child_process'
import { fstatSync } from 'node:fs'

const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h\u001b[2J\u001b[H'
const RESET_KITTY_KEYBOARD = '\u001b[<u'.repeat(16)
const ENABLE_MOUSE = '\u001b[?1002h\u001b[?1006h'
const ENABLE_MOUSE_MOTION = '\u001b[?1002l\u001b[?1003h'
const ENABLE_MOUSE_CLICKS = '\u001b[?1003l\u001b[?1002h'
const DISABLE_MOUSE = '\u001b[?1006l\u001b[?1003l\u001b[?1002l'
const LEAVE_ALTERNATE_SCREEN = `${DISABLE_MOUSE}\u001b[?25h\u001b[?1049l\u001b[?25h`
const SYNCHRONIZED_OUTPUT_START = '\u001b[?2026h'
const SYNCHRONIZED_OUTPUT_END = '\u001b[?2026l'
const SAVE_CURSOR = '\u001b7'
const RESTORE_CURSOR = '\u001b8'
const CURSOR_HOME = '\u001b[H'

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

export async function copyTerminalText(text: string, output: TerminalOutput = process.stdout): Promise<boolean> {
  if (!text) {
    return false
  }
  try {
    output.write(`\u001b]52;c;${Buffer.from(text).toString('base64')}\u001b\\`)
    if (process.platform !== 'darwin' || !output.isTTY) {
      return true
    }
    return await new Promise<boolean>((resolve) => {
      const clipboard = spawn('pbcopy', { stdio: ['pipe', 'ignore', 'ignore'] })
      clipboard.once('error', () => resolve(false))
      clipboard.once('close', (code) => resolve(code === 0))
      clipboard.stdin.once('error', () => resolve(false))
      clipboard.stdin.end(text)
    })
  } catch {
    return false
  }
}

export function createInkOutputs(
  output: NodeJS.WriteStream,
  errorOutput: NodeJS.WriteStream,
  alternateScreen: boolean
): { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream } {
  const parkCursor = alternateScreen && output.isTTY
  // Apple Terminal leaves stale frames when it receives DEC synchronized-output markers.
  const stripSynchronization = process.env.TERM_PROGRAM === 'Apple_Terminal'
  if (!parkCursor && !stripSynchronization) return { stdout: output, stderr: errorOutput }

  let cursorSaved = false
  const wrap = (stream: NodeJS.WriteStream): NodeJS.WriteStream =>
    new Proxy(stream, {
      get(target, property): unknown {
        if (property === 'write') {
          return (chunk: unknown, ...args: unknown[]): unknown => {
            if (typeof chunk === 'string') {
              if (stripSynchronization) {
                chunk = chunk.replaceAll(SYNCHRONIZED_OUTPUT_START, '').replaceAll(SYNCHRONIZED_OUTPUT_END, '')
              }
              if (parkCursor && chunk && chunk !== SYNCHRONIZED_OUTPUT_START && chunk !== SYNCHRONIZED_OUTPUT_END) {
                // A bottom-row cursor makes the terminal scroll before delivering a height resize.
                // Both streams must resume from the last write to their shared terminal.
                chunk = `${cursorSaved ? RESTORE_CURSOR : ''}${chunk}${SAVE_CURSOR}${CURSOR_HOME}`
                cursorSaved = true
              }
            }
            return Reflect.apply(target.write, target, [chunk, ...args])
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  const stdout = wrap(output)
  const stderr =
    parkCursor && shareTerminal(output, errorOutput)
      ? errorOutput === output
        ? stdout
        : wrap(errorOutput)
      : errorOutput
  return { stdout, stderr }
}

function shareTerminal(output: NodeJS.WriteStream, errorOutput: NodeJS.WriteStream): boolean {
  if (output === errorOutput) return true
  if (!output.isTTY || !errorOutput.isTTY) return false
  const stdoutFd = 'fd' in output ? output.fd : undefined
  const stderrFd = 'fd' in errorOutput ? errorOutput.fd : undefined
  if (typeof stdoutFd !== 'number' || typeof stderrFd !== 'number') return false
  try {
    const stdout = fstatSync(stdoutFd)
    const stderr = fstatSync(stderrFd)
    return (
      stdout.isCharacterDevice() &&
      stderr.isCharacterDevice() &&
      stdout.dev === stderr.dev &&
      stdout.ino === stderr.ino &&
      stdout.rdev === stderr.rdev
    )
  } catch {
    return false
  }
}
