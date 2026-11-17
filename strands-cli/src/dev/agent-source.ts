import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const PYTHON_TIMEOUT_MS = 10_000

export interface TextEdit {
  readonly start: number
  readonly end: number
  readonly text: string
}

export interface Span {
  readonly start: number
  readonly end: number
}

export class PythonReadFailure extends Error {}

export const applyEdits = (source: string, edits: readonly TextEdit[]): string =>
  [...edits]
    .sort((left, right) => right.start - left.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)

export const indentOf = (source: string, offset: number): string => {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*/u.exec(source.slice(lineStart))![0]
}

export const insertion = (
  source: string,
  { open, close }: { open: number; close: number },
  last: Span | undefined,
  trailingComma: boolean,
  emptyText: (entry: string) => string
): ((entry: string) => TextEdit) => {
  return (entry) => {
    const at = (position: number, text: string): TextEdit => ({ start: position, end: position, text })
    if (!last) return at(close, emptyText(entry))
    if (!source.slice(open, close).includes('\n'))
      return trailingComma ? at(close, `${entry}, `) : at(last.end, `, ${entry}`)
    const indent = indentOf(source, last.start)
    const closingLine = source.lastIndexOf('\n', close - 1) + 1
    if (trailingComma && !source.slice(closingLine, close).trim()) return at(closingLine, `${indent}${entry},\n`)
    if (trailingComma) return at(close, `${entry}, `)
    return at(last.end, `,\n${indent}${entry}`)
  }
}

const afterBlanks = (source: string, from: number): number => {
  let position = from
  while (source[position] === ' ' || source[position] === '\t') position++
  return position
}

export const removal = (source: string, { start, end }: Span): TextEdit => {
  const next = afterBlanks(source, end)
  if (source[next] === ',') {
    const lineStart = source.lastIndexOf('\n', start - 1) + 1
    const lineEnd = source.indexOf('\n', next + 1)
    if (!source.slice(lineStart, start).trim() && lineEnd >= 0 && !source.slice(next + 1, lineEnd).trim())
      return { start: lineStart, end: lineEnd + 1, text: '' }
    return { start, end: afterBlanks(source, next + 1), text: '' }
  }
  const before = source.slice(0, start).trimEnd()
  return before.endsWith(',') ? { start: before.length - 1, end, text: '' } : { start, end, text: '' }
}

export const projectPython = (root: string): string => {
  const environment = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  return existsSync(environment)
    ? environment
    : (process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'))
}

export const readPythonSource = <T>(script: string, source: string, interpreter: string): Promise<T> =>
  new Promise((resolvePromise, reject) => {
    const fail = (reason: string): void => reject(new PythonReadFailure(reason))
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(interpreter, ['-I', '-c', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: PYTHON_TIMEOUT_MS,
      })
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
      return
    }
    let output = ''
    let errors = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (errors += chunk))
    child.stdin.once('error', () => undefined)
    child.once('error', (error) => fail(error.message))
    child.once('close', (code) => {
      if (code !== 0) return fail(errors.trim().split('\n').at(-1) || `exit code ${code}`)
      try {
        resolvePromise(JSON.parse(output) as T)
      } catch {
        fail('it returned no result')
      }
    })
    child.stdin.end(source)
  })
