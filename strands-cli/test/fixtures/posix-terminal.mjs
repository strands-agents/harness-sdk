import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

export function spawnPosix(command, args, rows, env = process.env) {
  const child = spawn(
    env.PYTHON ?? 'python3',
    ['-u', fileURLToPath(new URL('./tui-integration-terminal.py', import.meta.url)), String(rows), command, ...args],
    { stdio: ['pipe', 'pipe', 'inherit'], env: { ...env, CI: 'false', TERM: 'xterm-256color' } }
  )
  const events = new EventEmitter()
  const decoder = new StringDecoder('utf8')
  const lines = createInterface({ input: child.stdout })
  let result
  lines.on('line', (line) => {
    const message = JSON.parse(line)
    if (message.type === 'data') events.emit('data', decoder.write(Buffer.from(message.data, 'base64')))
    else result = message
  })
  child.on('error', (error) => process.stderr.write(`${error.message}\n`))
  child.on('close', (code) => {
    events.emit('data', decoder.end())
    events.emit('exit', result ?? { exitCode: code ?? 1, inputModeRestored: false })
    lines.close()
  })
  const subscribe = (event, listener) => {
    events.on(event, listener)
    return { dispose: () => events.off(event, listener) }
  }
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
  return {
    onData: (listener) => subscribe('data', listener),
    onExit: (listener) => subscribe('exit', listener),
    write: (data) => send({ type: 'write', data }),
    resize: (columns, rows) => send({ type: 'resize', columns, rows }),
    kill: () => child.stdin.end(),
  }
}
