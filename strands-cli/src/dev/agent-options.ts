import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { DEFAULT_HARNESS_AGENT_CONFIG } from '@strands-agents/harness'
import type { CallExpression, Node, PropertyName, SourceFile } from 'typescript'

import type { ProfileEffort } from '../config/store.js'
import { profileEffort, resolveModelTarget } from '../model/selection.js'
import { sourceString } from '../project/source.js'
import { editFile } from './file-edits.js'
import type { DevWorkspace } from './workspace.js'

export interface AgentOptions {
  model?: string
  effort?: ProfileEffort
}

type OptionKey = keyof AgentOptions

export type AgentWorkspace = Pick<DevWorkspace, 'root' | 'entrypoint'> & {
  config: Pick<DevWorkspace['config'], 'language'>
}

export const entryOf = (workspace: AgentWorkspace): string =>
  relative(workspace.root, workspace.entrypoint) || workspace.entrypoint

export class AgentOptionsNotEditable extends Error {}

export class AgentOptionConflict extends Error {}

interface AgentOptionItem {
  readonly text: string
  readonly literal?: string
}

export type AgentOptionValue =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'null' }
  | { readonly kind: 'list'; readonly items: readonly AgentOptionItem[] }
  | { readonly kind: 'map'; readonly keys: readonly string[] }
  | { readonly kind: 'code' }

type AgentOptionScalar = string | boolean | readonly string[]

export type AgentOptionEdit =
  | {
      readonly option: string
      readonly value: AgentOptionScalar
      readonly expected?: AgentOptionScalar
      // The call must still leave the option out: the edit adds it.
      readonly absent?: boolean
      /** The source text to write for `value`, when the caller picks the quoting. */
      readonly literal?: string
    }
  | { readonly option: string; readonly removeItems: readonly number[]; readonly expectedItems: readonly string[] }
  | { readonly option: string; readonly removeKeys: readonly string[] }

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

class PythonReadFailure extends Error {}

export const applyEdits = (source: string, edits: readonly TextEdit[]): string =>
  [...edits]
    .sort((left, right) => right.start - left.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)

export const indentOf = (source: string, offset: number): string => {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*/u.exec(source.slice(lineStart))![0]
}

export const insertion =
  (
    source: string,
    { open, close }: { open: number; close: number },
    last: Span | undefined,
    trailingComma: boolean,
    padding: string
  ) =>
  (entries: readonly string[]): TextEdit => {
    const at = (position: number, text: string): TextEdit => ({ start: position, end: position, text })
    const each = (before: string, after: string): string => entries.map((entry) => `${before}${entry}${after}`).join('')
    if (!last) return at(close, `${padding}${entries.join(', ')}${padding}`)
    if (!source.slice(open, close).includes('\n'))
      return trailingComma ? at(close, each('', ', ')) : at(last.end, each(', ', ''))
    const indent = indentOf(source, last.start)
    const closingLine = source.lastIndexOf('\n', close - 1) + 1
    if (trailingComma && !source.slice(closingLine, close).trim()) return at(closingLine, each(indent, ',\n'))
    if (trailingComma) return at(close, each('', ', '))
    return at(last.end, each(`,\n${indent}`, ''))
  }

export const pythonInsertion = (
  source: string,
  call: { open: number; close: number },
  last: Span | undefined
): ((entries: readonly string[]) => TextEdit) => {
  const afterLast = last ? source.slice(last.end, call.close).replace(/#[^\r\n]*/gu, '') : ''
  return insertion(source, call, last, afterLast.includes(','), '')
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
      child = spawn(interpreter, ['-I', '-X', 'utf8', '-c', script], {
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

interface OptionValue extends Span {
  literal: string | undefined
  value: AgentOptionValue
  parts: readonly Span[]
  open: string
}

type OptionShape = Omit<OptionValue, 'start' | 'end'>

const CODE: OptionShape = { literal: undefined, value: { kind: 'code' }, parts: [], open: '' }

interface OptionCall {
  values: ReadonlyMap<string, OptionValue>
  extensible: boolean
  insert(entries: readonly string[]): TextEdit
}

const OPTION_KEYS: readonly OptionKey[] = ['model', 'effort']

const modelIdentity = (model: string): string => {
  try {
    const { provider, modelId } = resolveModelTarget(model)
    return `${provider}/${modelId}`
  } catch {
    return model
  }
}

const sameOption = (key: OptionKey, left: string, right: string): boolean =>
  key === 'model' ? modelIdentity(left) === modelIdentity(right) : profileEffort(left) === profileEffort(right)

export const propertyKey = (name: PropertyName | undefined, ts: typeof import('typescript')): string | undefined =>
  name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name))
    ? name.text
    : undefined

export const calleeName = (node: Node, ts: typeof import('typescript')): string | undefined =>
  ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : undefined

const typescriptString = (node: Node, ts: typeof import('typescript')): string | undefined =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined

const scalarShape = (value: AgentOptionValue, literal?: string): OptionShape => ({
  literal,
  value,
  parts: [],
  open: '',
})

const typescriptShape = (node: Node, file: SourceFile, ts: typeof import('typescript')): OptionShape => {
  const text = typescriptString(node, ts)
  if (text !== undefined) return scalarShape({ kind: 'string', value: text }, text)
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword)
    return scalarShape({ kind: 'boolean', value: node.kind === ts.SyntaxKind.TrueKeyword })
  if (node.kind === ts.SyntaxKind.NullKeyword) return scalarShape({ kind: 'null' })
  if (ts.isNumericLiteral(node)) return scalarShape({ kind: 'number', value: Number(node.text) })
  if (ts.isArrayLiteralExpression(node) && !node.elements.some((element) => ts.isSpreadElement(element)))
    return {
      literal: undefined,
      value: {
        kind: 'list',
        items: node.elements.map((element) => {
          const literal = typescriptString(element, ts)
          return { text: element.getText(file), ...(literal === undefined ? {} : { literal }) }
        }),
      },
      parts: node.elements.map((element) => ({ start: element.getStart(file), end: element.getEnd() })),
      open: '[',
    }
  if (ts.isObjectLiteralExpression(node)) {
    const keys = node.properties.map((property) =>
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name
        ? propertyKey(property.name, ts)
        : undefined
    )
    if (keys.every((key): key is string => key !== undefined))
      return {
        literal: undefined,
        value: { kind: 'map', keys },
        parts: node.properties.map((property) => ({ start: property.getStart(file), end: property.getEnd() })),
        open: '{',
      }
  }
  return CODE
}

export const harnessCalls = async (
  source: string,
  entry: string
): Promise<{ ts: typeof import('typescript'); file: SourceFile; calls: CallExpression[] }> => {
  const ts = (await import('typescript')).default
  const file = ts.createSourceFile(
    entry,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.m?js$/u.test(entry) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  )
  const calls: CallExpression[] = []
  const visit = (node: Node): void => {
    if (ts.isCallExpression(node) && calleeName(node.expression, ts) === 'createHarness') calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { ts, file, calls }
}

const typescriptCall = async (source: string, entry: string): Promise<OptionCall> => {
  const { ts, file, calls } = await harnessCalls(source, entry)
  if (calls.length !== 1)
    throw new AgentOptionsNotEditable(
      calls.length ? `${entry} calls createHarness more than once.` : `${entry} does not call createHarness.`
    )
  const object = calls[0]!.arguments.length === 1 ? calls[0]!.arguments[0] : undefined
  if (!object || !ts.isObjectLiteralExpression(object))
    throw new AgentOptionsNotEditable(`${entry} passes createHarness options that are not an object literal.`)
  const values = new Map<string, OptionValue>()
  for (const property of object.properties) {
    const key = propertyKey(property.name, ts)
    if (!key) continue
    if (values.has(key)) throw new AgentOptionsNotEditable(`${entry} sets ${key} more than once.`)
    const initializer = ts.isPropertyAssignment(property) ? property.initializer : undefined
    values.set(key, {
      start: (initializer ?? property).getStart(file),
      end: (initializer ?? property).getEnd(),
      ...(initializer ? typescriptShape(initializer, file, ts) : CODE),
    })
  }
  const last = object.properties.at(-1)
  return {
    values,
    extensible: true,
    insert: insertion(
      source,
      { open: object.getStart(file), close: object.getEnd() - 1 },
      last && { start: last.getStart(file), end: last.getEnd() },
      object.properties.hasTrailingComma,
      ' '
    ),
  }
}

const PYTHON_PARSER = `
import ast, json, re, sys
source = sys.stdin.read()
lines = re.findall(r'[^\\r\\n]*(?:\\r\\n|\\r|\\n)|[^\\r\\n]+$', source) or ['']
def offset(line, column):
    prefix = ''.join(lines[:line - 1]) + lines[line - 1].encode('utf-8')[:column].decode('utf-8')
    return len(prefix.encode('utf-16-le')) // 2
def span(node):
    return {'start': offset(node.lineno, node.col_offset), 'end': offset(node.end_lineno, node.end_col_offset)}
try:
    tree = ast.parse(source)
except SyntaxError as error:
    print(json.dumps({'syntax': error.lineno or 0}))
    sys.exit(0)`

const PYTHON_LOCATOR = `
def text(node):
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None
def describe(node):
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool):
            return {'kind': 'boolean', 'value': node.value}
        if node.value is None:
            return {'kind': 'null'}
        if isinstance(node.value, str):
            return {'kind': 'string', 'value': node.value}
        if isinstance(node.value, (int, float)):
            return {'kind': 'number', 'value': node.value}
        return {'kind': 'code'}
    if isinstance(node, (ast.List, ast.Tuple)) and not any(isinstance(item, ast.Starred) for item in node.elts):
        return {'kind': 'list', 'open': '[' if isinstance(node, ast.List) else '(', 'items': [dict(span(item), literal=text(item)) for item in node.elts]}
    if isinstance(node, ast.Dict) and all(text(key) is not None for key in node.keys):
        return {'kind': 'map', 'entries': [dict(start=span(key)['start'], end=span(value)['end'], key=key.value) for key, value in zip(node.keys, node.values)]}
    return {'kind': 'code'}
calls = []
for node in ast.walk(tree):
    if not isinstance(node, ast.Call):
        continue
    name = node.func.id if isinstance(node.func, ast.Name) else node.func.attr if isinstance(node.func, ast.Attribute) else None
    if name != 'create_harness':
        continue
    keywords = []
    for keyword in node.keywords:
        keywords.append(dict(span(keyword.value), name=keyword.arg, literal=text(keyword.value), value=describe(keyword.value)))
    calls.append({'open': span(node.func)['end'], 'end': span(node)['end'], 'arguments': [span(argument) for argument in node.args], 'keywords': keywords})
print(json.dumps({'calls': calls}))
`

type PythonValue =
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'null' }
  | { kind: 'list'; open: string; items: (Span & { literal: string | null })[] }
  | { kind: 'map'; entries: (Span & { key: string })[] }
  | { kind: 'code' }

interface PythonLocation {
  calls?: {
    open: number
    end: number
    arguments: Span[]
    keywords: (Span & { name: string | null; literal: string | null; value: PythonValue })[]
  }[]
}

const pythonShape = (source: string, value: PythonValue, literal: string | null): OptionShape => {
  if (value.kind === 'list')
    return {
      literal: undefined,
      value: {
        kind: 'list',
        items: value.items.map((item) => ({
          text: source.slice(item.start, item.end),
          ...(item.literal === null ? {} : { literal: item.literal }),
        })),
      },
      parts: value.items,
      open: value.open,
    }
  if (value.kind === 'map')
    return {
      literal: undefined,
      value: { kind: 'map', keys: value.entries.map(({ key }) => key) },
      parts: value.entries,
      open: '{',
    }
  return scalarShape(value, literal ?? undefined)
}

/** What `script` prints for the agent source, after the shared parser has read it. */
export const readPythonAgent = async <Reading>(
  script: string,
  source: string,
  entry: string,
  interpreter: string
): Promise<Reading> => {
  let reading: Reading & { syntax?: number }
  try {
    reading = await readPythonSource(PYTHON_PARSER + script, source, interpreter)
  } catch (error) {
    if (!(error instanceof PythonReadFailure)) throw error
    throw new AgentOptionsNotEditable(
      `Python 3.8 or newer could not read the agent source (${interpreter}): ${error.message}`
    )
  }
  if (reading.syntax !== undefined)
    throw new AgentOptionsNotEditable(`${entry} has a syntax error at line ${reading.syntax}. Fix it first.`)
  return reading
}

const pythonCall = async (source: string, entry: string, interpreter: string): Promise<OptionCall> => {
  const location = await readPythonAgent<PythonLocation>(PYTHON_LOCATOR, source, entry, interpreter)
  const calls = location.calls ?? []
  if (calls.length !== 1)
    throw new AgentOptionsNotEditable(
      calls.length ? `${entry} calls create_harness more than once.` : `${entry} does not call create_harness.`
    )
  const call = calls[0]!
  const values = new Map<string, OptionValue>()
  for (const keyword of call.keywords) {
    if (!keyword.name) continue
    values.set(keyword.name, {
      start: keyword.start,
      end: keyword.end,
      ...pythonShape(source, keyword.value, keyword.literal),
    })
  }
  const close = call.end - 1
  const last = [...call.arguments, ...call.keywords].sort((left, right) => left.end - right.end).at(-1)
  return {
    values,
    extensible: call.arguments.length === 0 && call.keywords.every((keyword) => keyword.name !== null),
    insert: pythonInsertion(source, { open: call.open, close }, last),
  }
}

const optionEntry = (key: OptionKey, value: string, python: boolean): string =>
  python ? `${key}=${sourceString(value, true)}` : `${key}: ${sourceString(value, false)}`

const setOptions = async (
  source: string,
  call: OptionCall,
  { entry, python, change, expected }: { entry: string; python: boolean; change: AgentOptions; expected: AgentOptions }
): Promise<string> => {
  const edits: TextEdit[] = []
  const insertions: string[] = []
  for (const key of OPTION_KEYS) {
    const value = change[key]
    if (value === undefined) continue
    const current = call.values.get(key)
    if (current && current.literal === undefined)
      throw new AgentOptionsNotEditable(`${entry} sets ${key} in code. Set it to "${value}" there yourself.`)
    const effective = current?.literal ?? DEFAULT_HARNESS_AGENT_CONFIG[key]
    const before = expected[key]
    if (before !== undefined && !sameOption(key, effective, before))
      throw new AgentOptionConflict(
        `${entry} now sets ${key} to "${effective}", not "${before}". Review the change again.`
      )
    if (sameOption(key, effective, value)) continue
    const written = key === 'model' ? modelIdentity(value) : value
    if (current) edits.push({ start: current.start, end: current.end, text: sourceString(written, python) })
    else if (!call.extensible)
      throw new AgentOptionsNotEditable(
        `${entry} passes create_harness options that strands dev cannot extend. Add ${key}="${value}" there yourself.`
      )
    else insertions.push(optionEntry(key, written, python))
  }
  if (insertions.length) edits.push(call.insert(insertions))
  return applyEdits(source, edits)
}

const optionCall = (workspace: AgentWorkspace, source: string): Promise<OptionCall> =>
  workspace.config.language === 'python'
    ? pythonCall(source, entryOf(workspace), projectPython(workspace.root))
    : typescriptCall(source, entryOf(workspace))

export const readAgentModel = async (workspace: AgentWorkspace): Promise<string | undefined> => {
  const source = await readFile(workspace.entrypoint, 'utf8')
  try {
    const model = (await optionCall(workspace, source)).values.get('model')
    if (!model) return modelIdentity(DEFAULT_HARNESS_AGENT_CONFIG.model)
    return model.literal === undefined ? undefined : modelIdentity(model.literal)
  } catch (error) {
    if (error instanceof AgentOptionsNotEditable) return undefined
    throw error
  }
}

export const saveAgentOptions = async (
  workspace: AgentWorkspace,
  change: AgentOptions,
  expected: AgentOptions = {}
): Promise<boolean> =>
  editFile(workspace.root, workspace.entrypoint, async (source) =>
    setOptions(source, await optionCall(workspace, source), {
      entry: entryOf(workspace),
      python: workspace.config.language === 'python',
      change,
      expected,
    })
  )

export const readAgentOptions = async (
  workspace: AgentWorkspace
): Promise<ReadonlyMap<string, AgentOptionValue> | undefined> => {
  const source = await readFile(workspace.entrypoint, 'utf8')
  try {
    const call = await optionCall(workspace, source)
    return new Map([...call.values].map(([key, { value }]) => [key, value]))
  } catch (error) {
    if (error instanceof AgentOptionsNotEditable) return undefined
    throw error
  }
}

const CLOSING: Record<string, string> = { '[': ']', '(': ')', '{': '}' }

const renderCollection = (original: string, open: string, items: readonly string[]): string => {
  const close = CLOSING[open] ?? ']'
  if (items.length === 0) return `${open}${close}`
  if (original.includes('\n')) {
    const itemIndent = /\n([ \t]*)\S/u.exec(original)?.[1] ?? '  '
    const closeIndent = /^[ \t]*/u.exec(original.slice(original.lastIndexOf('\n') + 1))![0]
    return `${open}\n${items.map((item) => `${itemIndent}${item},`).join('\n')}\n${closeIndent}${close}`
  }
  const padding = open === '{' && original[1] === ' ' ? ' ' : ''
  const tuple = open === '(' && items.length === 1 ? ',' : ''
  return `${open}${padding}${items.join(', ')}${tuple}${padding}${close}`
}

const renderScalar = (value: AgentOptionScalar, python: boolean): string => {
  if (typeof value === 'boolean') return python ? (value ? 'True' : 'False') : String(value)
  if (typeof value === 'string') return sourceString(value, python)
  return `[${value.map((item) => sourceString(item, python)).join(', ')}]`
}

const camelCase = (option: string): string => option.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase())

const UNSET_OPTIONS: Readonly<Record<string, unknown>> = {
  model: DEFAULT_HARNESS_AGENT_CONFIG.model,
  instructions: DEFAULT_HARNESS_AGENT_CONFIG.instructions,
  effort: 'auto',
  caching: 'auto',
  contextManager: 'auto',
  backgroundTasks: false,
  skills: true,
  builtinTools: DEFAULT_HARNESS_AGENT_CONFIG.builtinTools,
  builtinPlugins: DEFAULT_HARNESS_AGENT_CONFIG.builtinPlugins,
}

export const agentOptionDefault = (option: string): unknown => UNSET_OPTIONS[camelCase(option)]

// `instructions=None` is the same agent as one that leaves the option out.
const UNSET_WHEN_NULL: ReadonlySet<string> = new Set(['instructions'])

const currentScalar = (option: string, current: OptionValue | undefined): unknown => {
  if (!current) return agentOptionDefault(option)
  if (current.value.kind === 'null' && UNSET_WHEN_NULL.has(camelCase(option))) return agentOptionDefault(option)
  if (current.value.kind === 'list') return current.value.items.map((item) => item.literal ?? item.text)
  return 'value' in current.value ? current.value.value : current.value.kind === 'null' ? null : undefined
}

const sameScalar = (option: string, left: unknown, right: unknown): boolean => {
  if (camelCase(option) === 'model' && typeof left === 'string' && typeof right === 'string')
    return modelIdentity(left) === modelIdentity(right)
  return JSON.stringify(left) === JSON.stringify(right)
}

const scalarEdit = (
  source: string,
  call: OptionCall,
  { entry, python }: { entry: string; python: boolean },
  edit: Extract<AgentOptionEdit, { value: AgentOptionScalar }>
): TextEdit | string | undefined => {
  const current = call.values.get(edit.option)
  if (current && current.value.kind === 'code')
    throw new AgentOptionsNotEditable(
      `${entry} sets ${edit.option} in code. Set it to ${JSON.stringify(edit.value)} there yourself.`
    )
  if (edit.absent && current)
    throw new AgentOptionConflict(`${entry} now sets ${edit.option} itself. Review the change again.`)
  const effective = currentScalar(edit.option, current)
  if (!edit.absent && edit.expected !== undefined && !sameScalar(edit.option, effective, edit.expected))
    throw new AgentOptionConflict(
      `${entry} now sets ${edit.option} to ${JSON.stringify(effective)}, not ${JSON.stringify(edit.expected)}. Review the change again.`
    )
  if (!edit.absent && sameScalar(edit.option, effective, edit.value)) return undefined
  const written =
    camelCase(edit.option) === 'model' && typeof edit.value === 'string' ? modelIdentity(edit.value) : edit.value
  const text = edit.literal ?? renderScalar(written, python)
  if (current) return { start: current.start, end: current.end, text }
  if (!call.extensible)
    throw new AgentOptionsNotEditable(
      `${entry} passes options that strands dev cannot extend. Add ${edit.option} there yourself.`
    )
  return python ? `${edit.option}=${text}` : `${edit.option}: ${text}`
}

const collectionEdit = (
  source: string,
  call: OptionCall,
  entry: string,
  edit: Exclude<AgentOptionEdit, { value: AgentOptionScalar }>
): TextEdit => {
  const current = call.values.get(edit.option)
  const wanted = 'removeItems' in edit ? 'list' : 'map'
  if (!current || current.value.kind !== wanted)
    throw new AgentOptionsNotEditable(
      `${entry} does not set ${edit.option} as a ${wanted === 'list' ? 'list' : 'set of named entries'} that strands dev can edit. Change it there yourself.`
    )
  const parts = current.parts.map((part) => source.slice(part.start, part.end))
  let removed: (index: number) => boolean
  if ('removeItems' in edit) {
    if (JSON.stringify(parts) !== JSON.stringify(edit.expectedItems))
      throw new AgentOptionConflict(`${entry} changed ${edit.option} since the run. Review the change again.`)
    removed = (index): boolean => edit.removeItems.includes(index)
  } else {
    const keys = current.value.kind === 'map' ? current.value.keys : []
    const missing = edit.removeKeys.filter((key) => !keys.includes(key))
    if (missing.length)
      throw new AgentOptionConflict(
        `${entry} no longer sets ${missing.join(', ')} in ${edit.option}. Review the change again.`
      )
    removed = (index): boolean => edit.removeKeys.includes(keys[index]!)
  }
  return {
    start: current.start,
    end: current.end,
    text: renderCollection(
      source.slice(current.start, current.end),
      current.open,
      parts.filter((_, index) => !removed(index))
    ),
  }
}

const editedSource = async (
  workspace: AgentWorkspace,
  source: string,
  edits: readonly AgentOptionEdit[]
): Promise<string> => {
  const entry = entryOf(workspace)
  const python = workspace.config.language === 'python'
  const call = await optionCall(workspace, source)
  const replacements: TextEdit[] = []
  const insertions: string[] = []
  for (const edit of edits) {
    const change =
      'value' in edit ? scalarEdit(source, call, { entry, python }, edit) : collectionEdit(source, call, entry, edit)
    if (typeof change === 'string') insertions.push(change)
    else if (change) replacements.push(change)
  }
  if (insertions.length) replacements.push(call.insert(insertions))
  return applyEdits(source, replacements)
}

export const editAgentOptions = async (
  workspace: AgentWorkspace,
  edits: readonly AgentOptionEdit[]
): Promise<boolean> =>
  editFile(workspace.root, workspace.entrypoint, (source) => editedSource(workspace, source, edits))

/** Why the edits cannot be written into the agent file as it is now, or nothing when they can. It writes nothing. */
export const agentOptionEditsProblem = async (
  workspace: AgentWorkspace,
  edits: readonly AgentOptionEdit[]
): Promise<string | undefined> => {
  try {
    await editedSource(workspace, await readFile(workspace.entrypoint, 'utf8'), edits)
    return undefined
  } catch (error) {
    if (error instanceof AgentOptionsNotEditable || error instanceof AgentOptionConflict) return error.message
    throw error
  }
}
