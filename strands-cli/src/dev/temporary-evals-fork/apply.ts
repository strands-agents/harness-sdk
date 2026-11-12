import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'

import { isRecord } from '../../values.js'
import type { KnobKey } from '../panels/model.js'

export interface TemporaryEditRequest {
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
  readonly start: number
  readonly end: number
  readonly kind: LiteralKind
  readonly quote: string
  readonly prefix: string
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
const BRACES = /[{}]/u
const EFFORT_LEVEL = /^[A-Za-z0-9_-]+$/u
const LIMITS: Readonly<Record<LiteralKind, string>> = {
  plain: 'line breaks, quotes, or backslashes',
  triple: 'backslashes or closing quotes',
  template: 'backslashes, backticks, or ${',
}

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

const pythonLiterals = (source: string): Literal[] => {
  const literals: Literal[] = []
  const string = (open: number, prefix: string): number => {
    const quote = source[open]!
    const delimiter = source.startsWith(quote.repeat(3), open) ? quote.repeat(3) : quote
    const start = open + delimiter.length
    for (let index = start; index < source.length; index = stepOver(source, index)) {
      if (source.startsWith(delimiter, index)) {
        literals.push({ start, end: index, kind: delimiter.length > 1 ? 'triple' : 'plain', quote, prefix })
        return index + delimiter.length
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
    else if (!word) index += 1
    else {
      const prefix = word.toLowerCase()
      index += word.length
      if (isQuote(source[index]) && PYTHON_PREFIXES.has(prefix)) index = string(index, prefix)
    }
  }
  return literals
}

const javascriptLiterals = (source: string): Literal[] => {
  const literals: Literal[] = []
  const add = (start: number, end: number, kind: LiteralKind, quote: string): void => {
    literals.push({ start, end, kind, quote, prefix: '' })
  }
  const quoted = (open: number): number => {
    const quote = source[open]!
    for (let index = open + 1; index < source.length; index = stepOver(source, index)) {
      if (source[index] === quote) {
        add(open + 1, index, 'plain', quote)
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
    let start = open + 1
    let index = start
    while (index < source.length) {
      if (source[index] === '`' || source.startsWith('${', index)) add(start, index, 'template', '`')
      if (source[index] === '`') return index + 1
      if (source.startsWith('${', index)) {
        index = code(index + 2, true)
        start = index
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

const sourceLiterals = (entry: string, content: string): Literal[] =>
  extname(entry) === '.py' ? pythonLiterals(content) : javascriptLiterals(content)

const literalHolds = ({ kind, quote, prefix }: Literal, content: string): boolean => {
  if (content.includes('\\') || prefix.includes('b')) return false
  if (FORMATTED.test(prefix) && BRACES.test(content)) return false
  if (kind === 'plain') return !LINE_BREAK.test(content) && !content.includes(quote)
  if (kind === 'template') return !content.includes('`') && !content.includes('${')
  return !content.includes(quote.repeat(3)) && !content.endsWith(quote)
}

const limits = (literal: Literal): string =>
  FORMATTED.test(literal.prefix) ? `braces or ${LIMITS[literal.kind]}` : LIMITS[literal.kind]

const occurrences = (content: string, text: string): number => {
  let count = 0
  for (let at = text ? content.indexOf(text) : -1; at >= 0; at = content.indexOf(text, at + 1)) count += 1
  return count
}

const literalMatcher =
  (entry: string, before: string): Matcher =>
  (content) => {
    const paste = `Paste the new instructions into ${entry} yourself`
    const count = occurrences(content, before)
    if (count > 1) return { unavailable: `${paste}; the old text is there ${count} times.` }
    const at = content.indexOf(before)
    const literal =
      at < 0
        ? undefined
        : sourceLiterals(entry, content).find(({ start, end }) => start <= at && at + before.length <= end)
    if (!literal || !literalHolds(literal, content.slice(literal.start, literal.end)))
      return { unavailable: `${paste}; the old text is not a plain string there.` }
    return {
      rewrite: (after): Rewritten =>
        literalHolds(literal, content.slice(literal.start, at) + after + content.slice(at + before.length, literal.end))
          ? { content: content.slice(0, at) + after + content.slice(at + before.length) }
          : { problem: `${paste}; the string there cannot hold ${limits(literal)}, and the new text has some.` },
    }
  }

const textFileMatcher =
  (target: string, before: string): Matcher =>
  (content) =>
    content.trim() === before.trim()
      ? { rewrite: (after): Rewritten => ({ content: `${after.trimEnd()}${content.slice(content.trimEnd().length)}` }) }
      : { unavailable: `${target} no longer holds the old instructions. Paste the new instructions there yourself.` }

const effortMatcher =
  (entry: string, before: string): Matcher =>
  (content) => {
    const escaped = before.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    const setting = new RegExp(`(?<![\\w$])effort[ \\t]*[=:][ \\t]*(['"])${escaped}\\1`, 'gu')
    const literals = sourceLiterals(entry, content)
    const starts = [...content.matchAll(setting)]
      .map((match) => match.index + match[0].length - 1 - before.length)
      .filter((start) => literals.some((literal) => literal.start === start && literal.end === start + before.length))
    const [start] = starts
    if (starts.length !== 1 || start === undefined)
      return {
        unavailable: `Set the new effort in ${entry} yourself; it does not set effort to "${before}" in exactly one place.`,
      }
    return {
      rewrite: (after): Rewritten =>
        EFFORT_LEVEL.test(after)
          ? { content: content.slice(0, start) + after + content.slice(start + before.length) }
          : { problem: `Set the new effort in ${entry} yourself; "${after}" is not a plain effort level.` },
    }
  }

const rewriteFile = async (file: string, matcher: Matcher, after: string): Promise<void> => {
  const match = matcher(await readFile(file, 'utf8'))
  if ('unavailable' in match) throw new Error(match.unavailable)
  const rewritten = match.rewrite(after)
  if ('problem' in rewritten) throw new Error(rewritten.problem)
  await writeFile(file, rewritten.content)
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
  return { target: relative(root, file), write: (text) => rewriteFile(file, matcher, text) }
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

const locateInstructions = async (
  root: string,
  entrypoint: string,
  before: string,
  after: string | undefined
): Promise<TemporaryEditLocation> => {
  const entry = relative(root, entrypoint)
  if (!before.trim())
    return { unavailable: `Add the new instructions to ${entry} yourself; the agent has no instructions to replace.` }
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
  if (knob === 'effort') return located(root, file, effortMatcher(entry, before), after)
  return { unavailable: `Change the ${knob} in ${entry} yourself; strands dev applies only instructions and effort.` }
}
