import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'

import { DEFAULT_HARNESS_AGENT_CONFIG } from '@strands-agents/harness'
import type { Node, ObjectLiteralExpression, PropertyName, SourceFile } from 'typescript'

import type { ProfileEffort } from '../config/store.js'
import { profileEffort, resolveModelTarget } from '../model/selection.js'
import { sourceString } from '../project/source.js'
import { projectPython, PythonReadFailure, readPythonSource } from './agent-source.js'
import { editFile } from './file-edits.js'
import type { DevWorkspace } from './workspace.js'

export interface AgentOptions {
  model?: string
  effort?: ProfileEffort
}

type OptionKey = keyof AgentOptions

export class AgentOptionsNotEditable extends Error {}

export class AgentOptionConflict extends Error {}

export interface AgentOptionItem {
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

export type AgentOptionScalar = string | boolean | readonly string[]

export type AgentOptionEdit =
  | {
      readonly option: string
      readonly value: AgentOptionScalar
      readonly expected?: AgentOptionScalar
      /** The source text to write for `value`, when the caller picks the quoting. */
      readonly literal?: string
    }
  | { readonly option: string; readonly removeItems: readonly number[]; readonly expectedItems: readonly string[] }
  | { readonly option: string; readonly removeKeys: readonly string[] }

interface Span {
  start: number
  end: number
}

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
  insert(entries: readonly string[]): { at: number; text: string }
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

const indentOf = (source: string, offset: number): string => {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*/u.exec(source.slice(lineStart))![0]
}

const insertionBefore = (
  source: string,
  { open, close }: { open: number; close: number },
  last: { start: number; end: number } | undefined,
  trailingComma: boolean,
  emptyText: (entries: readonly string[]) => string
): ((entries: readonly string[]) => { at: number; text: string }) => {
  return (entries) => {
    if (!last) return { at: close, text: emptyText(entries) }
    const multiLine = source.slice(open, close).includes('\n')
    if (!multiLine)
      return trailingComma
        ? { at: close, text: entries.map((entry) => `${entry}, `).join('') }
        : { at: last.end, text: entries.map((entry) => `, ${entry}`).join('') }
    const indent = indentOf(source, last.start)
    const closingLine = source.lastIndexOf('\n', close - 1) + 1
    if (trailingComma && !source.slice(closingLine, close).trim())
      return { at: closingLine, text: entries.map((entry) => `${indent}${entry},\n`).join('') }
    if (trailingComma) return { at: close, text: entries.map((entry) => `${entry}, `).join('') }
    return { at: last.end, text: entries.map((entry) => `,\n${indent}${entry}`).join('') }
  }
}

const propertyKey = (name: PropertyName, ts: typeof import('typescript')): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) ? name.text : undefined

const calleeName = (node: Node, ts: typeof import('typescript')): string | undefined =>
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

const typescriptCall = async (source: string, entry: string): Promise<OptionCall> => {
  const ts = (await import('typescript')).default
  const file: SourceFile = ts.createSourceFile(
    entry,
    source,
    ts.ScriptTarget.Latest,
    true,
    /\.m?js$/u.test(entry) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  )
  const calls: Node[] = []
  const visit = (node: Node): void => {
    if (ts.isCallExpression(node) && calleeName(node.expression, ts) === 'createHarness') calls.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (calls.length !== 1)
    throw new AgentOptionsNotEditable(
      calls.length ? `${entry} calls createHarness more than once.` : `${entry} does not call createHarness.`
    )
  const call = calls[0]!
  const options = ts.isCallExpression(call) && call.arguments.length === 1 ? call.arguments[0] : undefined
  if (!options || !ts.isObjectLiteralExpression(options))
    throw new AgentOptionsNotEditable(`${entry} passes createHarness options that are not an object literal.`)
  const object: ObjectLiteralExpression = options
  const values = new Map<string, OptionValue>()
  for (const property of object.properties) {
    const key = property.name ? propertyKey(property.name, ts) : undefined
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
    insert: insertionBefore(
      source,
      { open: object.getStart(file), close: object.getEnd() - 1 },
      last ? { start: last.getStart(file), end: last.getEnd() } : undefined,
      object.properties.hasTrailingComma,
      (entries) => ` ${entries.join(', ')} `
    ),
  }
}

const PYTHON_LOCATOR = `
import ast, json, re, sys
source = sys.stdin.read()
lines = re.findall(r'[^\\r\\n]*(?:\\r\\n|\\r|\\n)|[^\\r\\n]+$', source) or ['']
def offset(line, column):
    prefix = ''.join(lines[:line - 1]) + lines[line - 1].encode('utf-8')[:column].decode('utf-8')
    return len(prefix.encode('utf-16-le')) // 2
def span(node):
    return {'start': offset(node.lineno, node.col_offset), 'end': offset(node.end_lineno, node.end_col_offset)}
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
try:
    tree = ast.parse(source)
except SyntaxError as error:
    print(json.dumps({'syntax': error.lineno or 0}))
    sys.exit(0)
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
  syntax?: number
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

const locatePython = async (source: string, interpreter: string): Promise<PythonLocation> => {
  try {
    return await readPythonSource<PythonLocation>(PYTHON_LOCATOR, source, interpreter)
  } catch (error) {
    if (!(error instanceof PythonReadFailure)) throw error
    throw new AgentOptionsNotEditable(
      `Python 3.8 or newer could not read the agent source (${interpreter}): ${error.message}`
    )
  }
}

const pythonCall = async (source: string, entry: string, interpreter: string): Promise<OptionCall> => {
  const location = await locatePython(source, interpreter)
  if (location.syntax !== undefined)
    throw new AgentOptionsNotEditable(`${entry} has a syntax error at line ${location.syntax}. Fix it first.`)
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
  const trailing = last
    ? source
        .slice(last.end, close)
        .replace(/#[^\r\n]*/gu, '')
        .includes(',')
    : false
  return {
    values,
    extensible: call.arguments.length === 0 && call.keywords.every((keyword) => keyword.name !== null),
    insert: insertionBefore(source, { open: call.open, close }, last, trailing, (entries) => entries.join(', ')),
  }
}

const optionEntry = (key: OptionKey, value: string, python: boolean): string =>
  python ? `${key}=${sourceString(value, true)}` : `${key}: ${sourceString(value, false)}`

const setOptions = async (
  source: string,
  call: OptionCall,
  { entry, python, change, expected }: { entry: string; python: boolean; change: AgentOptions; expected: AgentOptions }
): Promise<string> => {
  const replacements: { start: number; end: number; text: string }[] = []
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
    if (current) replacements.push({ start: current.start, end: current.end, text: sourceString(written, python) })
    else if (!call.extensible)
      throw new AgentOptionsNotEditable(
        `${entry} passes create_harness options that strands dev cannot extend. Add ${key}="${value}" there yourself.`
      )
    else insertions.push(optionEntry(key, written, python))
  }
  const edits = [...replacements]
  if (insertions.length) {
    const { at, text } = call.insert(insertions)
    edits.push({ start: at, end: at, text })
  }
  return edits
    .sort((left, right) => right.start - left.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)
}

export const readAgentModel = async (
  workspace: Pick<DevWorkspace, 'root' | 'entrypoint'> & { config: Pick<DevWorkspace['config'], 'language'> }
): Promise<string | undefined> => {
  const entry = relative(workspace.root, workspace.entrypoint) || workspace.entrypoint
  const source = await readFile(workspace.entrypoint, 'utf8')
  try {
    const call =
      workspace.config.language === 'python'
        ? await pythonCall(source, entry, projectPython(workspace.root))
        : await typescriptCall(source, entry)
    const model = call.values.get('model')
    if (!model) return modelIdentity(DEFAULT_HARNESS_AGENT_CONFIG.model)
    return model.literal === undefined ? undefined : modelIdentity(model.literal)
  } catch (error) {
    if (error instanceof AgentOptionsNotEditable) return undefined
    throw error
  }
}

export const saveAgentOptions = async (
  workspace: Pick<DevWorkspace, 'root' | 'entrypoint'> & { config: Pick<DevWorkspace['config'], 'language'> },
  change: AgentOptions,
  expected: AgentOptions = {}
): Promise<boolean> => {
  const entry = relative(workspace.root, workspace.entrypoint) || workspace.entrypoint
  const python = workspace.config.language === 'python'
  return editFile(workspace.root, workspace.entrypoint, async (source) =>
    setOptions(
      source,
      python ? await pythonCall(source, entry, projectPython(workspace.root)) : await typescriptCall(source, entry),
      { entry, python, change, expected }
    )
  )
}

type AgentWorkspace = Pick<DevWorkspace, 'root' | 'entrypoint'> & { config: Pick<DevWorkspace['config'], 'language'> }

const optionCall = async (workspace: AgentWorkspace, source: string): Promise<OptionCall> => {
  const entry = relative(workspace.root, workspace.entrypoint) || workspace.entrypoint
  return workspace.config.language === 'python'
    ? pythonCall(source, entry, projectPython(workspace.root))
    : typescriptCall(source, entry)
}

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
): { start: number; end: number; text: string } | string | undefined => {
  const current = call.values.get(edit.option)
  if (current && current.value.kind === 'code')
    throw new AgentOptionsNotEditable(
      `${entry} sets ${edit.option} in code. Set it to ${JSON.stringify(edit.value)} there yourself.`
    )
  const effective = currentScalar(edit.option, current)
  if (edit.expected !== undefined && !sameScalar(edit.option, effective, edit.expected))
    throw new AgentOptionConflict(
      `${entry} now sets ${edit.option} to ${JSON.stringify(effective)}, not ${JSON.stringify(edit.expected)}. Review the change again.`
    )
  if (sameScalar(edit.option, effective, edit.value)) return undefined
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
): { start: number; end: number; text: string } => {
  const current = call.values.get(edit.option)
  const wanted = 'removeItems' in edit ? 'list' : 'map'
  if (!current || current.value.kind !== wanted)
    throw new AgentOptionsNotEditable(
      `${entry} does not set ${edit.option} as a ${wanted === 'list' ? 'list' : 'set of named entries'} that strands dev can edit. Change it there yourself.`
    )
  const parts = current.parts.map((part) => source.slice(part.start, part.end))
  if ('removeItems' in edit) {
    if (JSON.stringify(parts) !== JSON.stringify(edit.expectedItems))
      throw new AgentOptionConflict(`${entry} changed ${edit.option} since the run. Review the change again.`)
    const removed = new Set(edit.removeItems)
    return {
      start: current.start,
      end: current.end,
      text: renderCollection(
        source.slice(current.start, current.end),
        current.open,
        parts.filter((_, index) => !removed.has(index))
      ),
    }
  }
  const keys = current.value.kind === 'map' ? current.value.keys : []
  const missing = edit.removeKeys.filter((key) => !keys.includes(key))
  if (missing.length)
    throw new AgentOptionConflict(
      `${entry} no longer sets ${missing.join(', ')} in ${edit.option}. Review the change again.`
    )
  return {
    start: current.start,
    end: current.end,
    text: renderCollection(
      source.slice(current.start, current.end),
      current.open,
      parts.filter((_, index) => !edit.removeKeys.includes(keys[index]!))
    ),
  }
}

const editedSource = async (
  workspace: AgentWorkspace,
  source: string,
  edits: readonly AgentOptionEdit[]
): Promise<string> => {
  const entry = relative(workspace.root, workspace.entrypoint) || workspace.entrypoint
  const python = workspace.config.language === 'python'
  const call = await optionCall(workspace, source)
  const replacements: { start: number; end: number; text: string }[] = []
  const insertions: string[] = []
  for (const edit of edits) {
    const change =
      'value' in edit ? scalarEdit(source, call, { entry, python }, edit) : collectionEdit(source, call, entry, edit)
    if (typeof change === 'string') insertions.push(change)
    else if (change) replacements.push(change)
  }
  if (insertions.length) {
    const { at, text } = call.insert(insertions)
    replacements.push({ start: at, end: at, text })
  }
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)
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
