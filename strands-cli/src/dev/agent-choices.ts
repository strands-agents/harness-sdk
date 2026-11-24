import { readFile } from 'node:fs/promises'

import type {
  Expression,
  NewExpression,
  Node,
  ObjectLiteralExpression,
  PropertyAssignment,
  SourceFile,
} from 'typescript'

import { effortFieldsKey, ModelEffortUnavailable, modelEffort, type ReasoningFields } from '../model/effort-fields.js'
import { sourceLiteral } from '../project/source.js'
import { isRecord } from '../values.js'
import {
  AgentOptionConflict,
  AgentOptionsNotEditable,
  applyEdits,
  calleeName,
  entryOf,
  harnessCalls,
  indentOf,
  insertion,
  pythonInsertion,
  projectPython,
  propertyKey,
  readPythonAgent,
  saveAgentOptions,
  type AgentOptions,
  type AgentWorkspace,
  type Span,
  type TextEdit,
} from './agent-options.js'
import { editFile } from './file-edits.js'

interface ModelConstructor {
  readonly className: string
  readonly python: boolean
  readonly api: unknown
  readonly modelId: unknown
  readonly maxTokens: unknown
  readonly fields: unknown
  write(fields: ReasoningFields | undefined): string
}

type ModelReading = { readonly kind: 'option' } | { readonly kind: 'object'; readonly model: ModelConstructor }

type TypeScript = typeof import('typescript')

const OPTION: ModelReading = { kind: 'option' }
const TS_INDENT = 2
const PYTHON_INDENT = 4

const notEditable = (entry: string, problem: string): AgentOptionsNotEditable =>
  new AgentOptionsNotEditable(`${entry} ${problem} Set effort on that model yourself.`)

const unavailableIn = (entry: string, error: ModelEffortUnavailable): AgentOptionsNotEditable =>
  new AgentOptionsNotEditable(`${entry}: ${error.message} Set effort on that model yourself.`)

const depthAt = (source: string, offset: number, python: boolean): number =>
  Math.floor(indentOf(source, offset).length / (python ? PYTHON_INDENT : TS_INDENT))

const textLeaves = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(textLeaves)
      : isRecord(value)
        ? [...Object.keys(value), ...Object.values(value).flatMap(textLeaves)]
        : []

const fieldsLiteral = (
  fields: ReasoningFields,
  { python, depth, inline }: { python: boolean; depth: number; inline: boolean }
): string => {
  const text = sourceLiteral(fields, python, depth)
  if (!inline || textLeaves(fields).some((leaf) => /[\n,{}[\]]/u.test(leaf))) return text
  const inlined = text
    .split('\n')
    .map((line) => line.trim())
    .join(' ')
    .replace(/,\s*([}\]])/gu, ' $1')
  return python ? inlined.replace(/([[{]) /gu, '$1').replace(/ ([}\]])/gu, '$1') : inlined
}

const afterBlanks = (source: string, from: number): number => {
  let position = from
  while (source[position] === ' ' || source[position] === '\t') position++
  return position
}

const removal = (source: string, { start, end }: Span): TextEdit => {
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

const unwrapped = (node: Expression, ts: TypeScript): Expression =>
  ts.isParenthesizedExpression(node) ||
  ts.isAsExpression(node) ||
  ts.isSatisfiesExpression(node) ||
  ts.isNonNullExpression(node)
    ? unwrapped(node.expression, ts)
    : node

const jsonValue = (node: Expression, ts: TypeScript): { value: unknown } | undefined => {
  const inner = unwrapped(node, ts)
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner)) return { value: inner.text }
  if (ts.isNumericLiteral(inner)) return { value: Number(inner.text) }
  if (
    ts.isPrefixUnaryExpression(inner) &&
    inner.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(inner.operand)
  )
    return { value: -Number(inner.operand.text) }
  if (inner.kind === ts.SyntaxKind.TrueKeyword) return { value: true }
  if (inner.kind === ts.SyntaxKind.FalseKeyword) return { value: false }
  if (inner.kind === ts.SyntaxKind.NullKeyword) return { value: null }
  if (ts.isArrayLiteralExpression(inner)) {
    const items = inner.elements.map((element) => (ts.isSpreadElement(element) ? undefined : jsonValue(element, ts)))
    return items.every((item) => item !== undefined) ? { value: items.map((item) => item!.value) } : undefined
  }
  if (!ts.isObjectLiteralExpression(inner)) return undefined
  const value: Record<string, unknown> = {}
  for (const property of inner.properties) {
    const key = ts.isPropertyAssignment(property) ? propertyKey(property.name, ts) : undefined
    const item = key === undefined ? undefined : jsonValue((property as PropertyAssignment).initializer, ts)
    if (key === undefined || item === undefined) return undefined
    value[key] = item.value
  }
  return { value }
}

interface TypeScriptContext {
  readonly source: string
  readonly file: SourceFile
  readonly entry: string
  readonly ts: TypeScript
}

const typescriptSettings = (
  expression: NewExpression,
  { entry, ts }: TypeScriptContext
): { className: string; settings: ObjectLiteralExpression; properties: readonly PropertyAssignment[] } => {
  const className = calleeName(expression.expression, ts) ?? 'model'
  const [settings, ...rest] = expression.arguments ?? []
  if (!settings || rest.length > 0 || !ts.isObjectLiteralExpression(settings))
    throw notEditable(entry, `passes its ${className} settings in code that strands dev cannot edit.`)
  const properties = settings.properties.filter((property): property is PropertyAssignment =>
    ts.isPropertyAssignment(property)
  )
  if (
    properties.length !== settings.properties.length ||
    properties.some((property) => !propertyKey(property.name, ts))
  )
    throw notEditable(entry, `builds its ${className} settings with code that strands dev cannot edit.`)
  return { className, settings, properties }
}

const typescriptConstructor = (expression: NewExpression, context: TypeScriptContext): ModelConstructor => {
  const { source, file, entry, ts } = context
  const { className, settings, properties } = typescriptSettings(expression, context)
  const key = fieldsKey(className, false, entry)
  const property = (name: string): PropertyAssignment | undefined =>
    properties.find((candidate) => propertyKey(candidate.name, ts) === name)
  const literal = (name: string): unknown => {
    const found = property(name)
    return found && jsonValue(found.initializer, ts)?.value
  }
  const fieldsProperty = property(key)
  if (fieldsProperty && !jsonValue(fieldsProperty.initializer, ts))
    throw notEditable(entry, `sets the ${className} ${key} in code.`)
  const last = properties.at(-1)
  const add = insertion(
    source,
    { open: settings.getStart(file), close: settings.getEnd() - 1 },
    last && { start: last.getStart(file), end: last.getEnd() },
    settings.properties.hasTrailingComma,
    ' '
  )
  const layout = {
    python: false,
    depth: depthAt(source, (last ?? settings).getStart(file), false),
    inline: !source.slice(settings.getStart(file), settings.getEnd()).includes('\n'),
  }
  const edit = (fields: ReasoningFields | undefined): TextEdit | undefined => {
    if (!fieldsProperty) return fields && add([`${key}: ${fieldsLiteral(fields, layout)}`])
    if (!fields) return removal(source, { start: fieldsProperty.getStart(file), end: fieldsProperty.getEnd() })
    const value = fieldsProperty.initializer
    return { start: value.getStart(file), end: value.getEnd(), text: fieldsLiteral(fields, layout) }
  }
  return constructorReading(
    source,
    {
      className,
      python: false,
      api: literal('api'),
      modelId: literal('modelId'),
      maxTokens: literal('maxTokens'),
      fields: literal(key),
    },
    edit
  )
}

const constructorReading = (
  source: string,
  model: Omit<ModelConstructor, 'write'>,
  edit: (fields: ReasoningFields | undefined) => TextEdit | undefined
): ModelConstructor => ({
  ...model,
  write: (fields): string => {
    const change = edit(fields)
    return change ? applyEdits(source, [change]) : source
  },
})

const fieldsKey = (className: string, python: boolean, entry: string): string => {
  try {
    return effortFieldsKey(className, python)
  } catch (error) {
    if (error instanceof ModelEffortUnavailable) throw unavailableIn(entry, error)
    throw error
  }
}

const typescriptModelValue = (
  node: Expression,
  context: TypeScriptContext,
  seen: ReadonlySet<string> = new Set()
): ModelReading => {
  const { ts, file, entry } = context
  const inner = unwrapped(node, ts)
  if (ts.isStringLiteral(inner) || ts.isNoSubstitutionTemplateLiteral(inner) || ts.isTemplateExpression(inner))
    return OPTION
  if (ts.isNewExpression(inner)) return { kind: 'object', model: typescriptConstructor(inner, context) }
  if (ts.isIdentifier(inner) && !seen.has(inner.text)) {
    const declarations: Expression[] = []
    const visit = (child: Node): void => {
      if (ts.isVariableDeclaration(child) && ts.isIdentifier(child.name) && child.name.text === inner.text)
        declarations.push(child.initializer ?? child.name)
      ts.forEachChild(child, visit)
    }
    visit(file)
    if (declarations.length === 1)
      return typescriptModelValue(declarations[0]!, context, new Set([...seen, inner.text]))
  }
  throw notEditable(entry, 'builds its model in code that strands dev cannot read.')
}

const typescriptModel = async (source: string, entry: string): Promise<ModelReading> => {
  const { ts, file, calls } = await harnessCalls(source, entry)
  const [options, ...extra] = calls.length === 1 ? calls[0]!.arguments : []
  if (!options || extra.length > 0 || !ts.isObjectLiteralExpression(options)) return OPTION
  const model = options.properties.find((property) => propertyKey(property.name, ts) === 'model')
  const value =
    model && ts.isPropertyAssignment(model)
      ? model.initializer
      : model && ts.isShorthandPropertyAssignment(model)
        ? model.name
        : undefined
  if (model && !value) throw notEditable(entry, 'builds its model in code that strands dev cannot read.')
  return value ? typescriptModelValue(value, { source, file, entry, ts }) : OPTION
}

const PYTHON_MODEL_READER = `
def name_of(node):
    return node.id if isinstance(node, ast.Name) else node.attr if isinstance(node, ast.Attribute) else None
def literal(node):
    try:
        return {'value': json.loads(json.dumps(ast.literal_eval(node)))}
    except Exception:
        return {'code': True}
def keyword(node):
    found = dict(literal(node.value), name=node.arg, value_span=span(node.value))
    found['span'] = span(node) if hasattr(node, 'lineno') else None
    return found
def describe(node, tree, seen):
    if node is None or isinstance(node, ast.JoinedStr) or (isinstance(node, ast.Constant) and isinstance(node.value, str)):
        return {'kind': 'option'}
    if isinstance(node, ast.Name) and node.id not in seen:
        values = [statement.value for statement in tree.body if isinstance(statement, ast.Assign) and len(statement.targets) == 1 and isinstance(statement.targets[0], ast.Name) and statement.targets[0].id == node.id]
        values += [statement.value for statement in tree.body if isinstance(statement, ast.AnnAssign) and isinstance(statement.target, ast.Name) and statement.target.id == node.id and statement.value is not None]
        return describe(values[0], tree, seen | {node.id}) if len(values) == 1 else {'kind': 'code'}
    if isinstance(node, ast.Call):
        return {'kind': 'call', 'name': name_of(node.func), 'positional': len(node.args), 'open': span(node.func)['end'], 'close': span(node)['end'] - 1, 'keywords': [keyword(item) for item in node.keywords]}
    return {'kind': 'code'}
calls = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and name_of(node.func) == 'create_harness']
model = next((item.value for item in calls[0].keywords if item.arg == 'model'), None) if len(calls) == 1 else None
print(json.dumps(describe(model, tree, frozenset()) if len(calls) == 1 else {'kind': 'option'}))
`

interface PythonKeyword {
  readonly name: string | null
  readonly span: Span | null
  readonly value_span: Span
  readonly value?: unknown
  readonly code?: true
}

interface PythonModelReading {
  readonly kind?: 'option' | 'code' | 'call'
  readonly name?: string | null
  readonly positional?: number
  readonly open?: number
  readonly close?: number
  readonly keywords?: readonly PythonKeyword[]
}

const pythonConstructor = (source: string, entry: string, call: PythonModelReading): ModelConstructor => {
  const className = call.name ?? 'model'
  const key = fieldsKey(className, true, entry)
  const keywords = call.keywords ?? []
  const named = (name: string): PythonKeyword | undefined => keywords.find((item) => item.name === name)
  const fieldsKeyword = named(key)
  if (fieldsKeyword?.code) throw notEditable(entry, `sets the ${className} ${key} in code.`)
  const close = call.close ?? source.length
  const last = keywords.map((item) => item.span ?? item.value_span).at(-1)
  const extensible = (call.positional ?? 0) === 0 && keywords.every((item) => item.name !== null)
  const add = pythonInsertion(source, { open: call.open ?? close, close }, last)
  const layout = {
    python: true,
    depth: depthAt(source, last?.start ?? close, true),
    inline: !source.slice(call.open ?? close, close).includes('\n'),
  }
  const edit = (fields: ReasoningFields | undefined): TextEdit | undefined => {
    if (fieldsKeyword && !fields && fieldsKeyword.span) return removal(source, fieldsKeyword.span)
    if (fieldsKeyword) return { ...fieldsKeyword.value_span, text: fieldsLiteral(fields ?? {}, layout) }
    if (!fields) return undefined
    if (!extensible) throw notEditable(entry, `passes ${className} settings that strands dev cannot extend.`)
    return add([`${key}=${fieldsLiteral(fields, layout)}`])
  }
  return constructorReading(
    source,
    {
      className,
      python: true,
      api: undefined,
      modelId: named('model_id')?.value,
      maxTokens: named('max_tokens')?.value,
      fields: fieldsKeyword?.value,
    },
    edit
  )
}

const pythonModel = async (source: string, entry: string, interpreter: string): Promise<ModelReading> => {
  const reading = await readPythonAgent<PythonModelReading>(PYTHON_MODEL_READER, source, entry, interpreter)
  if (reading.kind === 'code') throw notEditable(entry, 'builds its model in code that strands dev cannot read.')
  return reading.kind === 'call' ? { kind: 'object', model: pythonConstructor(source, entry, reading) } : OPTION
}

const effortSource = async (
  source: string,
  model: ModelConstructor,
  { entry, effort, expected }: { entry: string; effort: string; expected: string | undefined }
): Promise<string> => {
  try {
    const state = await modelEffort(model)
    if (expected !== undefined && state.current !== expected)
      throw new AgentOptionConflict(
        `${entry} now runs its model at effort "${state.current}", not "${expected}". Review the change again.`
      )
    return effort === state.current ? source : model.write(state.fieldsFor(effort))
  } catch (error) {
    if (error instanceof ModelEffortUnavailable) throw unavailableIn(entry, error)
    throw error
  }
}

const modelReader =
  (workspace: AgentWorkspace, entry: string) =>
  (source: string): Promise<ModelReading> =>
    workspace.config.language === 'python'
      ? pythonModel(source, entry, projectPython(workspace.root))
      : typescriptModel(source, entry)

export const saveAgentChoices = async (
  workspace: AgentWorkspace,
  change: AgentOptions,
  expected: AgentOptions = {}
): Promise<boolean> => {
  const { effort } = change
  const entry = entryOf(workspace)
  const read = modelReader(workspace, entry)
  if (effort === undefined || change.model !== undefined) return saveAgentOptions(workspace, change, expected)
  if ((await read(await readFile(workspace.entrypoint, 'utf8'))).kind === 'option')
    return saveAgentOptions(workspace, change, expected)
  return editFile(workspace.root, workspace.entrypoint, async (source) => {
    const reading = await read(source)
    if (reading.kind === 'option')
      throw new AgentOptionConflict(`${entry} changed its model while strands dev saved the effort. Try again.`)
    return effortSource(source, reading.model, { entry, effort, expected: expected.effort })
  })
}

export const agentChoicesProblem = async (
  workspace: AgentWorkspace,
  change: AgentOptions,
  expected: AgentOptions = {}
): Promise<string | undefined> => {
  const { effort } = change
  if (effort === undefined || change.model !== undefined) return undefined
  const entry = entryOf(workspace)
  try {
    const source = await readFile(workspace.entrypoint, 'utf8')
    const reading = await modelReader(workspace, entry)(source)
    if (reading.kind === 'object')
      await effortSource(source, reading.model, { entry, effort, expected: expected.effort })
    return undefined
  } catch (error) {
    if (error instanceof AgentOptionsNotEditable || error instanceof AgentOptionConflict) return error.message
    throw error
  }
}
