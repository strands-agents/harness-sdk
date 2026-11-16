import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { DEFAULT_HARNESS_AGENT_CONFIG } from '@strands-agents/harness'
import type { Node, ObjectLiteralExpression, PropertyName, SourceFile } from 'typescript'

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

export class AgentOptionsNotEditable extends Error {}

export class AgentOptionConflict extends Error {}

interface OptionValue {
  start: number
  end: number
  literal: string | undefined
}

interface OptionCall {
  values: ReadonlyMap<string, OptionValue>
  extensible: boolean
  insert(entries: readonly string[]): { at: number; text: string }
}

const OPTION_KEYS: readonly OptionKey[] = ['model', 'effort']
const PYTHON_TIMEOUT_MS = 10_000

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
    if (!key || !OPTION_KEYS.includes(key as OptionKey)) continue
    if (values.has(key)) throw new AgentOptionsNotEditable(`${entry} sets ${key} more than once.`)
    const initializer = ts.isPropertyAssignment(property) ? property.initializer : undefined
    const literal =
      initializer && (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
        ? initializer.text
        : undefined
    values.set(key, {
      start: (initializer ?? property).getStart(file),
      end: (initializer ?? property).getEnd(),
      literal,
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
        literal = keyword.value.value if isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, str) else None
        keywords.append(dict(span(keyword.value), name=keyword.arg, literal=literal))
    calls.append({'open': span(node.func)['end'], 'end': span(node)['end'], 'arguments': [span(argument) for argument in node.args], 'keywords': keywords})
print(json.dumps({'calls': calls}))
`

interface PythonLocation {
  syntax?: number
  calls?: {
    open: number
    end: number
    arguments: { start: number; end: number }[]
    keywords: { start: number; end: number; name: string | null; literal: string | null }[]
  }[]
}

const pythonInterpreter = (root: string): string => {
  const environment = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  return existsSync(environment)
    ? environment
    : (process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'))
}

const locatePython = (source: string, interpreter: string): Promise<PythonLocation> =>
  new Promise((resolvePromise, reject) => {
    const fail = (reason: string): void =>
      reject(
        new AgentOptionsNotEditable(`Python 3.8 or newer could not read the agent source (${interpreter}): ${reason}`)
      )
    const child = spawn(interpreter, ['-I', '-c', PYTHON_LOCATOR], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: PYTHON_TIMEOUT_MS,
    })
    let output = ''
    let errors = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (errors += chunk))
    child.stdin.once('error', () => undefined)
    child.once('error', (error) => fail(error.message))
    child.once('close', (code) => {
      if (code !== 0) return fail(errors.trim().split('\n').at(-1) || `exit code ${code}`)
      try {
        resolvePromise(JSON.parse(output) as PythonLocation)
      } catch {
        fail('it returned no result')
      }
    })
    child.stdin.end(source)
  })

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
    if (!keyword.name || !OPTION_KEYS.includes(keyword.name as OptionKey)) continue
    values.set(keyword.name, { start: keyword.start, end: keyword.end, literal: keyword.literal ?? undefined })
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
        ? await pythonCall(source, entry, pythonInterpreter(workspace.root))
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
      python ? await pythonCall(source, entry, pythonInterpreter(workspace.root)) : await typescriptCall(source, entry),
      { entry, python, change, expected }
    )
  )
}
