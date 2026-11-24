import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'

import { isRecord } from '../../values.js'
import { agentChoicesProblem, saveAgentChoices } from '../agent-choices.js'
import {
  agentOptionEditsProblem,
  editAgentOptions,
  type AgentOptionEdit,
  type AgentWorkspace,
} from '../agent-options.js'
import { editFile } from '../file-edits.js'
import type { ProfileEffort } from '../../config/store.js'
import type { KnobKey } from '../panels/model.js'

interface TemporaryEditRequest {
  readonly root: string
  readonly entrypoint: string
  readonly knob: KnobKey
  readonly before: string
  readonly after?: string
}

export interface TemporaryEditTarget {
  readonly target: string
  write(after: string): Promise<void>
}

export type TemporaryEditLocation = TemporaryEditTarget | { readonly unavailable: string }

type LiteralKind = 'plain' | 'triple' | 'template'

interface Literal {
  readonly open: number
  readonly start: number
  readonly end: number
  readonly close: number
  readonly kind: LiteralKind
  readonly quote: string
  readonly prefix: string
  readonly depth: number
}

interface Chain {
  readonly literals: readonly Literal[]
  readonly value: string
}

type Rewritten = { readonly content: string } | { readonly problem: string }

type Match = { readonly rewrite: (after: string) => Rewritten } | { readonly unavailable: string }

type Matcher = (content: string) => Match

const SKIPPED_FOLDERS = new Set(['node_modules', '.venv', '.git', 'dist'])
const WORKSPACE_FOLDER_PREFIX = 'strands-dev'
const TEXT_EXTENSIONS = new Set(['.md', '.txt'])
const PADDING_BYTES = 64 * 1024
const UNREADABLE = new Set(['EACCES', 'EPERM', 'ENOENT'])
const PYTHON_PREFIXES = new Set(['r', 'u', 'f', 'b', 't', 'br', 'rb', 'fr', 'rf', 'tr', 'rt'])
const REGEX_AFTER = new Set([
  ...'(,=:[!&|?{};+-*%<>~^',
  '',
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
])
const WORD = /[A-Za-z0-9_$]+/uy
const LINE_BREAK = /[\r\n]/u
const FORMATTED = /[ft]/u
const RAW = /r/giu
const BRACES = /[{}]/u
const OPENING_BRACKETS = '([{'
const CLOSING_BRACKETS = ')]}'
const JAVASCRIPT_JOIN = /^\s*\+\s*$/u
const PYTHON_JOIN = /^(?:[ \t\f]|\\\r?\n)*\+?(?:[ \t\f]|\\\r?\n)*$/u
const PYTHON_BRACKETED_JOIN = /^\s*\+?\s*$/u
const EFFORT_LEVEL = /^[A-Za-z0-9_-]+$/u
const HEX = /^[0-9a-fA-F]+$/u
const OCTAL_DIGIT = /[0-7]/u
const DIGIT = /[0-9]/u
const LAST_CONTROL_CODE = 0x1f
const DELETE_CODE = 0x7f
const JAVASCRIPT_ESCAPES: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v' }
const PYTHON_ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\',
  "'": "'",
  '"': '"',
  a: '\u0007',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
}
const LINE_CONTINUATIONS = new Set(['\n', '\u2028', '\u2029'])

const lineEnd = (source: string, from: number): number => {
  const end = source.indexOf('\n', from)
  return end < 0 ? source.length : end
}

const commentEnd = (source: string, from: number): number => {
  if (source[from + 1] === '/') return lineEnd(source, from)
  const end = source.indexOf('*/', from + 2)
  return end < 0 ? source.length : end + 2
}

const wordAt = (source: string, index: number): string | undefined => {
  WORD.lastIndex = index
  return WORD.exec(source)?.[0]
}

const stepOver = (source: string, index: number): number => index + (source[index] === '\\' ? 2 : 1)

const isQuote = (char: string | undefined): boolean => char === "'" || char === '"'

const isComment = (source: string, index: number): boolean =>
  source[index] === '/' && (source[index + 1] === '/' || source[index + 1] === '*')

const bracketStep = (char: string): number =>
  OPENING_BRACKETS.includes(char) ? 1 : CLOSING_BRACKETS.includes(char) ? -1 : 0

const pythonLiterals = (source: string): Literal[] => {
  const literals: Literal[] = []
  let depth = 0
  const string = (open: number, prefix: string): number => {
    const quote = source[open]!
    const delimiter = source.startsWith(quote.repeat(3), open) ? quote.repeat(3) : quote
    const start = open + delimiter.length
    for (let index = start; index < source.length; index = stepOver(source, index)) {
      if (source.startsWith(delimiter, index)) {
        const kind = delimiter.length > 1 ? 'triple' : 'plain'
        const close = index + delimiter.length
        literals.push({ open: open - prefix.length, start, end: index, close, kind, quote, prefix, depth })
        return close
      }
      if (delimiter.length === 1 && source[index] === '\n') return index
    }
    return source.length
  }
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    const word = wordAt(source, index)
    if (char === '#') index = lineEnd(source, index)
    else if (isQuote(char)) index = string(index, '')
    else if (!word) {
      depth = Math.max(0, depth + bracketStep(char))
      index += 1
    } else {
      const prefix = word.toLowerCase()
      index += word.length
      if (isQuote(source[index]) && PYTHON_PREFIXES.has(prefix)) index = string(index, word)
    }
  }
  return literals
}

const javascriptLiterals = (source: string): Literal[] => {
  const literals: Literal[] = []
  const add = (open: number, start: number, end: number, kind: LiteralKind, quote: string): void => {
    literals.push({ open, start, end, close: end + 1, kind, quote, prefix: '', depth: 0 })
  }
  const quoted = (open: number): number => {
    const quote = source[open]!
    for (let index = open + 1; index < source.length; index = stepOver(source, index)) {
      if (source[index] === quote) {
        add(open, open + 1, index, 'plain', quote)
        return index + 1
      }
      if (source[index] === '\n') return index
    }
    return source.length
  }
  const regex = (open: number): number => {
    let inClass = false
    for (let index = open + 1; index < source.length; index = stepOver(source, index)) {
      const char = source[index]
      if (char === '\n') return index
      if (char === '/' && !inClass) return index + 1
      if (char === '[' || char === ']') inClass = char === '['
    }
    return source.length
  }
  const template = (open: number): number => {
    let index = open + 1
    let interpolated = false
    while (index < source.length) {
      if (source[index] === '`') {
        if (!interpolated) add(open, open + 1, index, 'template', '`')
        return index + 1
      }
      if (source.startsWith('${', index)) {
        interpolated = true
        index = code(index + 2, true)
      } else index = stepOver(source, index)
    }
    return source.length
  }
  const literalScanners: Readonly<Record<string, (open: number) => number>> = {
    "'": quoted,
    '"': quoted,
    '`': template,
  }
  const code = (from: number, closing: boolean): number => {
    let index = from
    let depth = 0
    let previous = ''
    while (index < source.length) {
      const char = source[index]!
      const word = wordAt(source, index)
      const scan = literalScanners[char] ?? (char === '/' && REGEX_AFTER.has(previous) ? regex : undefined)
      if (isComment(source, index)) index = commentEnd(source, index)
      else if (scan) {
        index = scan(index)
        previous = 'literal'
      } else if (word) {
        index += word.length
        previous = word
      } else if (closing && char === '}' && depth === 0) return index + 1
      else {
        if (closing && char === '{') depth += 1
        if (closing && char === '}') depth -= 1
        if (!/\s/u.test(char)) previous = char
        index += 1
      }
    }
    return index
  }
  code(0, false)
  return literals
}

const isPython = (entry: string): boolean => extname(entry) === '.py'

const sourceLiterals = (entry: string, content: string): Literal[] =>
  isPython(entry) ? pythonLiterals(content) : javascriptLiterals(content)

const hexCode = (text: string, length: number): number | undefined =>
  text.length === length && HEX.test(text) ? Number.parseInt(text, 16) : undefined

const decodedJavaScript = (raw: string, kind: LiteralKind): string | undefined => {
  let value = ''
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]!
    if (char === '\r' && kind === 'template') {
      value += '\n'
      if (raw[index + 1] === '\n') index += 1
      continue
    }
    if (char !== '\\') {
      value += char
      continue
    }
    const next = raw[index + 1]
    if (next === undefined) return undefined
    index += 1
    if (next === '\r') {
      if (raw[index + 1] === '\n') index += 1
    } else if (LINE_CONTINUATIONS.has(next)) continue
    else if (next in JAVASCRIPT_ESCAPES) value += JAVASCRIPT_ESCAPES[next]
    else if (next === '0' && !DIGIT.test(raw[index + 1] ?? '')) value += '\0'
    else if (DIGIT.test(next)) return undefined
    else if (next === 'x') {
      const code = hexCode(raw.slice(index + 1, index + 3), 2)
      if (code === undefined) return undefined
      value += String.fromCharCode(code)
      index += 2
    } else if (next === 'u' && raw[index + 1] === '{') {
      const close = raw.indexOf('}', index + 2)
      const code = close < 0 ? undefined : hexCode(raw.slice(index + 2, close), close - index - 2)
      if (code === undefined || code > 0x10ffff) return undefined
      value += String.fromCodePoint(code)
      index = close
    } else if (next === 'u') {
      const code = hexCode(raw.slice(index + 1, index + 5), 4)
      if (code === undefined) return undefined
      value += String.fromCharCode(code)
      index += 4
    } else value += next
  }
  return value
}

const pythonEscape = (raw: string, index: number): { readonly value: string; readonly length: number } | undefined => {
  const next = raw[index + 1]
  if (next === undefined) return undefined
  if (next === '\n') return { value: '', length: 2 }
  if (next === '\r') return { value: '', length: raw[index + 2] === '\n' ? 3 : 2 }
  const known = PYTHON_ESCAPES[next]
  if (known !== undefined) return { value: known, length: 2 }
  if (OCTAL_DIGIT.test(next)) {
    let digits = next
    while (digits.length < 3 && OCTAL_DIGIT.test(raw[index + 1 + digits.length] ?? ''))
      digits += raw[index + 1 + digits.length]
    return { value: String.fromCharCode(Number.parseInt(digits, 8)), length: 1 + digits.length }
  }
  const widths: Readonly<Record<string, number>> = { x: 2, u: 4, U: 8 }
  const width = widths[next]
  if (width !== undefined) {
    const code = hexCode(raw.slice(index + 2, index + 2 + width), width)
    if (code === undefined || code > 0x10ffff) return undefined
    return { value: String.fromCodePoint(code), length: 2 + width }
  }
  if (next === 'N') return undefined
  return { value: `\\${next}`, length: 2 }
}

const decodedPython = (raw: string, prefix: string): string | undefined => {
  const lower = prefix.toLowerCase()
  if (lower.includes('b')) return undefined
  const formatted = FORMATTED.test(lower)
  const escapes = !lower.includes('r')
  let value = ''
  for (let index = 0; index < raw.length;) {
    const char = raw[index]!
    if (formatted && (char === '{' || char === '}')) {
      if (raw[index + 1] !== char) return undefined
      value += char
      index += 2
    } else if (escapes && char === '\\') {
      const escape = pythonEscape(raw, index)
      if (!escape) return undefined
      value += escape.value
      index += escape.length
    } else {
      value += char
      index += 1
    }
  }
  return value
}

const decoded = (entry: string, content: string, literal: Literal): string | undefined => {
  const raw = content.slice(literal.start, literal.end)
  return isPython(entry) ? decodedPython(raw, literal.prefix) : decodedJavaScript(raw, literal.kind)
}

const joined = (entry: string, content: string, left: Literal, right: Literal): boolean => {
  const gap = content.slice(left.close, right.open)
  if (!isPython(entry)) return JAVASCRIPT_JOIN.test(gap)
  return PYTHON_JOIN.test(gap) || (left.depth > 0 && right.depth > 0 && PYTHON_BRACKETED_JOIN.test(gap))
}

const literalChains = (entry: string, content: string): Chain[] => {
  const groups: Literal[][] = []
  for (const literal of sourceLiterals(entry, content)) {
    const group = groups.at(-1)
    const last = group?.at(-1)
    if (group && last && joined(entry, content, last, literal)) group.push(literal)
    else groups.push([literal])
  }
  return groups.flatMap((literals) => {
    const values = literals.map((literal) => decoded(entry, content, literal))
    return values.every((value) => value !== undefined) ? [{ literals, value: values.join('') }] : []
  })
}

const holdsVerbatim = ({ kind, quote, prefix }: Literal, content: string): boolean => {
  if (content.includes('\\') || prefix.toLowerCase().includes('b')) return false
  if (FORMATTED.test(prefix.toLowerCase()) && BRACES.test(content)) return false
  if (kind === 'plain') return !LINE_BREAK.test(content) && !content.includes(quote)
  if (kind === 'template') return !content.includes('`') && !content.includes('${') && !content.includes('\r')
  return !content.includes(quote.repeat(3)) && !content.endsWith(quote)
}

const isControl = (char: string): boolean => {
  const code = char.charCodeAt(0)
  return code <= LAST_CONTROL_CODE || code === DELETE_CODE
}

const controlEscape = (char: string): string => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`

const javascriptLiteral = (value: string, { kind, quote }: Literal): string => {
  if (kind === 'template' || LINE_BREAK.test(value)) {
    const body = value.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${').replaceAll('\r', '\\r')
    return `\`${body}\``
  }
  const body = [...value]
    .map((char) => {
      if (char === '\\' || char === quote) return `\\${char}`
      if (char === '\t') return '\\t'
      if (char === '\u2028' || char === '\u2029') return `\\u${char.charCodeAt(0).toString(16)}`
      return isControl(char) ? controlEscape(char) : char
    })
    .join('')
  return `${quote}${body}${quote}`
}

const pythonLiteral = (value: string, { kind, quote, prefix }: Literal): string => {
  const kept = prefix.replace(RAW, '')
  const formatted = FORMATTED.test(kept.toLowerCase())
  const triple = kind === 'triple' || LINE_BREAK.test(value)
  const delimiter = triple ? quote.repeat(3) : quote
  const body = [...value]
    .map((char) => {
      if (char === '\\' || char === quote) return `\\${char}`
      if (formatted && (char === '{' || char === '}')) return `${char}${char}`
      if (triple && (char === '\n' || char === '\t')) return char
      if (char === '\n') return '\\n'
      if (char === '\t') return '\\t'
      if (char === '\r') return '\\r'
      return isControl(char) ? controlEscape(char) : char
    })
    .join('')
  return `${kept}${delimiter}${body}${delimiter}`
}

const occurrences = (content: string, text: string): number => {
  let count = 0
  for (let at = text ? content.indexOf(text) : -1; at >= 0; at = content.indexOf(text, at + 1)) count += 1
  return count
}

const rewriteChain = (
  entry: string,
  content: string,
  { literals, value }: Chain,
  before: string,
  after: string
): string => {
  const [first] = literals
  const last = literals.at(-1)
  const at = value.indexOf(before)
  const next = value.slice(0, at) + after + value.slice(at + before.length)
  if (!first || !last) return content
  const raw = content.slice(first.start, first.end)
  if (literals.length === 1 && raw === value && holdsVerbatim(first, next))
    return content.slice(0, first.start) + next + content.slice(first.end)
  const literal = isPython(entry) ? pythonLiteral(next, first) : javascriptLiteral(next, first)
  return content.slice(0, first.open) + literal + content.slice(last.close)
}

const literalMatcher =
  (entry: string, before: string): Matcher =>
  (content) => {
    const paste = `Paste the new instructions into ${entry} yourself`
    const chains = literalChains(entry, content)
    const count = chains.reduce((total, chain) => total + occurrences(chain.value, before), 0)
    if (count > 1) return { unavailable: `${paste}; the old text is there ${count} times.` }
    const chain = chains.find(({ value }) => value.includes(before))
    if (!chain || !before) return { unavailable: `${paste}; the old text is not a plain string there.` }
    return { rewrite: (after): Rewritten => ({ content: rewriteChain(entry, content, chain, before, after) }) }
  }

const textFileMatcher =
  (target: string, before: string): Matcher =>
  (content) =>
    content.trim() === before.trim()
      ? { rewrite: (after): Rewritten => ({ content: `${after.trimEnd()}${content.slice(content.trimEnd().length)}` }) }
      : { unavailable: `${target} no longer holds the old instructions. Paste the new instructions there yourself.` }

const rewriteFile = async (root: string, file: string, matcher: Matcher, after: string): Promise<void> => {
  await editFile(root, file, (content) => {
    const match = matcher(content)
    // The old text was found when the edit was offered, so not finding it now means the file changed since.
    if ('unavailable' in match)
      throw new Error(
        `${relative(root, file)} changed after this edit was proposed, and the text it replaces is no longer there.`
      )
    const rewritten = match.rewrite(after)
    if ('problem' in rewritten) throw new Error(rewritten.problem)
    return rewritten.content
  })
}

const located = async (
  root: string,
  file: string,
  matcher: Matcher,
  after: string | undefined
): Promise<TemporaryEditLocation> => {
  const match = matcher(await readFile(file, 'utf8'))
  if ('unavailable' in match) return match
  const rewritten = after === undefined ? undefined : match.rewrite(after)
  if (rewritten && 'problem' in rewritten) return { unavailable: rewritten.problem }
  return { target: relative(root, file), write: (text) => rewriteFile(root, file, matcher, text) }
}

const unlessUnreadable = async <T>(read: () => Promise<T>, fallback: T): Promise<T> => {
  try {
    return await read()
  } catch (error) {
    if (isRecord(error) && typeof error.code === 'string' && UNREADABLE.has(error.code)) return fallback
    throw error
  }
}

const textFiles = async (folder: string): Promise<string[]> => {
  const entries = await unlessUnreadable(() => readdir(folder, { withFileTypes: true }), [])
  const found = await Promise.all(
    entries.map(async (entry) => {
      const path = join(folder, entry.name)
      if (entry.isDirectory())
        return SKIPPED_FOLDERS.has(entry.name) || entry.name.startsWith(WORKSPACE_FOLDER_PREFIX) ? [] : textFiles(path)
      return entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()) ? [path] : []
    })
  )
  return found.flat()
}

const holds = (path: string, text: string): Promise<boolean> =>
  unlessUnreadable(async () => {
    const { size } = await stat(path)
    const length = Buffer.byteLength(text)
    return size >= length && size <= length + PADDING_BYTES && (await readFile(path, 'utf8')).trim() === text
  }, false)

const filesHolding = async (root: string, before: string): Promise<string[]> => {
  const held: string[] = []
  for (const path of (await textFiles(root)).sort()) if (await holds(path, before.trim())) held.push(path)
  return held
}

const languageOf = (file: string): 'python' | 'typescript' => (extname(file) === '.py' ? 'python' : 'typescript')

// A string the agent file does not hold yet: quoted the way each language's own strings are in a generated agent.
const NEW_LITERAL = { open: 0, start: 0, end: 0, close: 0, kind: 'plain', prefix: '', depth: 0 } as const

const newInstructions = (entry: string, text: string): AgentOptionEdit => ({
  option: 'instructions',
  value: text,
  expected: '',
  literal: isPython(entry)
    ? pythonLiteral(text, { ...NEW_LITERAL, quote: '"' })
    : javascriptLiteral(text, { ...NEW_LITERAL, quote: "'" }),
})

/** An agent that sets no instructions gets them as a new option, where a setting it leaves at its default goes. */
const addInstructions = async (
  workspace: AgentWorkspace,
  after: string | undefined
): Promise<TemporaryEditLocation> => {
  const entry = relative(workspace.root, workspace.entrypoint)
  const problem = await agentOptionEditsProblem(workspace, [newInstructions(entry, after ?? 'instructions')])
  if (problem) return { unavailable: `Add the new instructions to ${entry} yourself. ${problem}` }
  return {
    target: entry,
    write: async (text): Promise<void> => {
      await editAgentOptions(workspace, [newInstructions(entry, text)])
    },
  }
}

const locateInstructions = async (
  root: string,
  entrypoint: string,
  before: string,
  after: string | undefined
): Promise<TemporaryEditLocation> => {
  const entry = relative(root, entrypoint)
  if (!before.trim()) return addInstructions({ root, entrypoint, config: { language: languageOf(entrypoint) } }, after)
  const files = await filesHolding(root, before)
  const names = files.map((file) => relative(root, file))
  const source = await readFile(entrypoint, 'utf8')
  const [only] = files
  if (only && files.length === 1 && !source.includes(before))
    return located(root, only, textFileMatcher(relative(root, only), before), after)
  if (only && files.length === 1)
    return {
      unavailable: `The old instructions are in ${names[0]} and in ${entry}. Paste the new instructions into the one the agent reads yourself.`,
    }
  const matcher = literalMatcher(entry, before)
  if ('rewrite' in matcher(source) || files.length < 2) return located(root, entrypoint, matcher, after)
  return {
    unavailable: `The old instructions are in ${files.length} files (${names.join(', ')}). Paste the new instructions into the one the agent reads yourself.`,
  }
}

const effortEdit = async (
  workspace: AgentWorkspace,
  before: string,
  after: string | undefined
): Promise<TemporaryEditLocation> => {
  const problem =
    after === undefined
      ? undefined
      : await agentChoicesProblem(workspace, { effort: after as ProfileEffort }, { effort: before as ProfileEffort })
  if (problem) return { unavailable: problem }
  return {
    target: relative(workspace.root, workspace.entrypoint),
    write: async (text): Promise<void> => {
      if (!EFFORT_LEVEL.test(text)) throw new Error(`"${text}" is not a plain effort level.`)
      await saveAgentChoices(workspace, { effort: text as ProfileEffort }, { effort: before as ProfileEffort })
    },
  }
}

export const locateTemporaryEdit = async ({
  root,
  entrypoint,
  knob,
  before,
  after,
}: TemporaryEditRequest): Promise<TemporaryEditLocation> => {
  const file = resolve(root, entrypoint)
  const entry = relative(root, file)
  if (knob === 'instructions') return locateInstructions(root, file, before, after)
  if (knob === 'effort')
    return effortEdit({ root, entrypoint: file, config: { language: languageOf(file) } }, before, after)
  return { unavailable: `Change the ${knob} in ${entry} yourself; strands dev applies only instructions and effort.` }
}
