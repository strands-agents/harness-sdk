import { constants, type Stats } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import ts from 'typescript'

import { containsPath, expandHome } from '../paths.js'
import { importAgentProject } from '../project/import.js'
import { hasIgnoredDirectory } from '../project/packaging.js'
import { isRecord } from '../values.js'
import { readDevWorkspace, type DevWorkspace } from './workspace.js'

export interface DiscoveredHarness {
  name: string
  entrypoint: string
  root: string
  language: 'typescript' | 'python'
  workspace?: DevWorkspace
  preparationStatus?: 'Needs setup' | 'Manual setup' | 'Check setup'
}

export interface HarnessDiscovery {
  harnesses: DiscoveredHarness[]
  warnings: string[]
}

const SOURCE_EXTENSION = /\.(?:ts|mts|js|mjs|py)$/u
const MAX_SOURCE_BYTES = 1024 * 1024
const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  '.strands',
])

interface DiscoveryState {
  harnesses: Map<string, DiscoveredHarness>
  warnings: Set<string>
  visited: Set<string>
  vendored: Set<string>
}

export async function discoverHarnesses(roots: readonly string[]): Promise<HarnessDiscovery> {
  const state: DiscoveryState = { harnesses: new Map(), warnings: new Set(), visited: new Set(), vendored: new Set() }
  const paths = new Set<string>()
  for (const root of roots) {
    if (!root.trim()) warn(state, root, new Error('Discovery root must not be empty.'))
    else paths.add(resolve(expandHome(root)))
  }
  for (const path of [...paths].sort()) await visit(path, state, true)
  return {
    harnesses: [...state.harnesses.values()].sort((left, right) => comparePaths(left.entrypoint, right.entrypoint)),
    warnings: [...state.warnings].sort(),
  }
}

async function visit(path: string, state: DiscoveryState, explicit = false): Promise<void> {
  if (hasIgnoredDirectory(path, IGNORED_DIRECTORIES) || [...state.vendored].some((root) => containsPath(root, path))) {
    return
  }
  if (state.visited.has(path)) return
  state.visited.add(path)
  try {
    const details = await lstat(path)
    if (details.isSymbolicLink()) {
      if (explicit) throw new Error('Discovery does not follow symbolic links.')
      return
    }
    if ((await realpath(path)) !== path) throw new Error('Discovery path contains a symbolic link.')
    if (details.isDirectory()) await scanDirectory(path, state)
    else if (details.isFile() && SOURCE_EXTENSION.test(path)) await scanSource(path, details, state)
    else if (explicit || SOURCE_EXTENSION.test(path))
      throw new Error('Choose a directory or a .ts, .mts, .js, .mjs, or .py source file.')
  } catch (error) {
    warn(state, path, error)
  }
}

async function scanDirectory(root: string, state: DiscoveryState): Promise<void> {
  try {
    const workspace = await readDevWorkspace(root)
    if (workspace) {
      state.harnesses.set(workspace.entrypoint, {
        name: workspace.config.name,
        entrypoint: workspace.entrypoint,
        root: workspace.root,
        language: workspace.config.language,
        workspace,
      })
      if (workspace.config.harness) state.vendored.add(resolve(workspace.root, workspace.config.harness.path))
      if (workspace.directory) state.vendored.add(join(workspace.directory, 'tmp'))
    }
  } catch (error) {
    warn(state, join(root, '.strands', 'config.json'), error)
  }
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((left, right) =>
    comparePaths(left.name, right.name)
  )) {
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory() || SOURCE_EXTENSION.test(entry.name)) await visit(join(root, entry.name), state)
  }
}

async function scanSource(path: string, details: Stats, state: DiscoveryState): Promise<void> {
  if (state.harnesses.has(path)) return
  const source = await readSource(path, details)
  const language = path.endsWith('.py') ? 'python' : 'typescript'
  const harness = language === 'python' ? pythonHarness(source) : typescriptHarness(path, source)
  if (!harness) return
  await guardProjectMetadata(path)
  const { root } = importAgentProject(path)
  if (!containsPath(root, path)) throw new Error('Imported project root must contain its harness entrypoint.')
  state.harnesses.set(path, { name: harness.name ?? basename(path), entrypoint: path, root, language })
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function warn(state: DiscoveryState, path: string, error: unknown): void {
  state.warnings.add(`${path || '(empty path)'}: ${error instanceof Error ? error.message : String(error)}`)
}

async function optionalDetails(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function guardProjectMetadata(entrypoint: string): Promise<void> {
  const directory = dirname(entrypoint)
  const boundaries = await Promise.all([homedir(), tmpdir(), process.cwd()].map((path) => realpath(path)))
  for (let current = directory; dirname(current) !== current; current = dirname(current)) {
    if (current !== directory && boundaries.slice(0, 2).includes(current)) return
    if ((await optionalDetails(join(current, '.strands-entrypoint')))?.isFile()) return
    const manifest = join(current, 'package.json')
    const details = await optionalDetails(manifest)
    if (details?.isFile()) {
      await readSource(manifest, details)
      return
    }
    if (
      (await optionalDetails(join(current, 'pyproject.toml')))?.isFile() ||
      (await optionalDetails(join(current, 'requirements.txt')))?.isFile() ||
      boundaries.includes(current) ||
      (await optionalDetails(join(current, '.git')))
    ) {
      return
    }
  }
}

async function readSource(path: string, expected: Stats): Promise<string> {
  if (!expected.isFile() || expected.size > MAX_SOURCE_BYTES) {
    throw new Error(`Discovery requires a regular source file no larger than ${MAX_SOURCE_BYTES} bytes.`)
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const details = await file.stat()
    if (
      !details.isFile() ||
      details.ino !== expected.ino ||
      details.dev !== expected.dev ||
      (await realpath(path)) !== path
    ) {
      throw new Error('Source changed or contains a symbolic link.')
    }
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > MAX_SOURCE_BYTES) throw new Error(`Source exceeds ${MAX_SOURCE_BYTES} bytes.`)
    return buffer.subarray(0, length).toString('utf8')
  } finally {
    await file.close()
  }
}

interface StaticHarness {
  name: string | undefined
}

function typescriptHarness(path: string, source: string): StaticHarness | undefined {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  if (diagnostics.length) throw new Error(ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, '\n'))
  const constructors = new Set<string>()
  const namespaces = new Set<string>()
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== '@strands-agents/harness' ||
      statement.importClause?.isTypeOnly
    ) {
      continue
    }
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text)
    if (!bindings || !ts.isNamedImports(bindings)) continue
    for (const binding of bindings.elements) {
      if (!binding.isTypeOnly && (binding.propertyName ?? binding.name).text === 'createHarness') {
        constructors.add(binding.name.text)
      }
    }
  }
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || statement.declarationList.declarations.length !== 1) continue
    const declaration = statement.declarationList.declarations[0]!
    if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'agent' || !declaration.initializer) continue
    const expression = declaration.initializer
    const call = ts.isAwaitExpression(expression) ? expression.expression : expression
    if (!ts.isCallExpression(call) || call.arguments.length > 1) continue
    const factory = call.expression
    const imported =
      (ts.isIdentifier(factory) && constructors.has(factory.text)) ||
      (ts.isPropertyAccessExpression(factory) &&
        ts.isIdentifier(factory.expression) &&
        namespaces.has(factory.expression.text) &&
        factory.name.text === 'createHarness')
    if (imported) return { name: typescriptName(call.arguments[0]) }
  }
  return undefined
}

function typescriptName(options: ts.Expression | undefined): string | undefined {
  if (!options || !ts.isObjectLiteralExpression(options)) return undefined
  for (const property of [...options.properties].reverse()) {
    if (ts.isSpreadAssignment(property) || (property.name && ts.isComputedPropertyName(property.name))) return undefined
    if (!property.name || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) continue
    if (property.name.text !== 'name') continue
    if (ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)) {
      return displayName(property.initializer.text)
    }
    return undefined
  }
  return undefined
}

function displayName(value: string | undefined): string | undefined {
  return value?.trim() && !/\p{Cc}/u.test(value) ? value : undefined
}

interface PythonToken {
  value: string
  kind: 'word' | 'string' | 'symbol'
  literal?: string
}

interface PythonStatement {
  indent: number
  tokens: PythonToken[]
}

function pythonHarness(source: string): StaticHarness | undefined {
  const statements = pythonStatements(source).filter((statement) => statement.indent === 0)
  const constructors = new Set<string>()
  const namespaces = new Set<string>()
  for (const { tokens } of statements) pythonImports(tokens, constructors, namespaces)
  for (const { tokens } of statements) {
    if (tokens[0]?.kind !== 'word' || tokens[0].value !== 'agent') continue
    const assignment = tokens.findIndex((token) => token.value === '=')
    if (assignment < 0 || (assignment !== 1 && tokens[1]?.value !== ':')) continue
    const expression = tokens.slice(assignment + 1)
    const factory = expression[0]
    if (factory?.kind !== 'word') continue
    const namespaced =
      namespaces.has(factory.value) && expression[1]?.value === '.' && expression[2]?.value === 'create_harness'
    const opening = namespaced ? 3 : 1
    if (!namespaced && !constructors.has(factory.value)) continue
    if (expression[opening]?.value !== '(' || expression.at(-1)?.value !== ')') continue
    const argumentsList = expression.slice(opening + 1, -1)
    if (!balancedArguments(argumentsList)) continue
    return { name: pythonName(argumentsList) }
  }
  return undefined
}

function pythonImports(tokens: PythonToken[], constructors: Set<string>, namespaces: Set<string>): void {
  if (tokens[0]?.kind !== 'word') return
  const fromHarness =
    tokens[0].value === 'from' && tokens[1]?.value === 'strands_harness' && tokens[2]?.value === 'import'
  if (!fromHarness && tokens[0].value !== 'import') return
  const bindings = tokens.slice(fromHarness ? 3 : 1).filter((token) => !['(', ')'].includes(token.value))
  for (let index = 0; index < bindings.length; index++) {
    const token = bindings[index]
    const expected = fromHarness ? 'create_harness' : 'strands_harness'
    if (token?.value !== expected || (index > 0 && bindings[index - 1]?.value !== ',')) continue
    const next = bindings[index + 1]?.value
    if (next && next !== ',' && next !== 'as') continue
    const alias = next === 'as' ? bindings[index + 2]?.value : expected
    if (alias) (fromHarness ? constructors : namespaces).add(alias)
  }
}

function balancedArguments(tokens: PythonToken[]): boolean {
  let depth = 0
  for (const token of tokens) {
    if (token.kind !== 'symbol') continue
    if (['(', '[', '{'].includes(token.value)) depth++
    if ([')', ']', '}'].includes(token.value) && --depth < 0) return false
  }
  return depth === 0
}

function pythonName(tokens: PythonToken[]): string | undefined {
  let depth = 0
  let name: string | undefined
  for (const [index, token] of tokens.entries()) {
    if (depth === 0 && token.value === '*' && tokens[index + 1]?.value === '*') name = undefined
    if (depth === 0 && token.value === 'name' && tokens[index + 1]?.value === '=') {
      const value = tokens[index + 2]
      name =
        value?.kind === 'string' && (!tokens[index + 3] || tokens[index + 3]?.value === ',') ? value.literal : undefined
    }
    if (token.kind !== 'symbol') continue
    if (['(', '[', '{'].includes(token.value)) depth++
    if ([')', ']', '}'].includes(token.value)) depth--
  }
  return displayName(name)
}

function pythonStatements(source: string): PythonStatement[] {
  const statements: PythonStatement[] = []
  let statement: PythonStatement = { indent: 0, tokens: [] }
  const brackets: string[] = []
  let lineStart = true
  let indentation = 0
  for (let index = source.charCodeAt(0) === 0xfeff ? 1 : 0; index < source.length;) {
    const character = source[index]!
    if (character === '\n' || (character === ';' && !brackets.length)) {
      if (!brackets.length && statement.tokens.length) {
        statements.push(statement)
        if (
          character === ';' &&
          [
            'def',
            'async',
            'class',
            'if',
            'elif',
            'else',
            'for',
            'while',
            'try',
            'except',
            'finally',
            'with',
            'match',
            'case',
          ].includes(statement.tokens[0]!.value)
        ) {
          indentation++
        }
        statement = { indent: 0, tokens: [] }
      }
      lineStart = character === '\n'
      if (lineStart) indentation = 0
      index++
      continue
    }
    if (/\s/u.test(character)) {
      if (lineStart) indentation += character === '\t' ? 8 : 1
      index++
      continue
    }
    if (character === '#') {
      index = source.indexOf('\n', index)
      if (index < 0) break
      continue
    }
    if (character === '\\' && /^\r?\n/u.test(source.slice(index + 1, index + 3))) {
      index += source[index + 1] === '\r' ? 3 : 2
      continue
    }
    if (!statement.tokens.length) statement.indent = indentation
    lineStart = false
    const quoted = /^(?:[rubf]{1,2})?(?:'''|"""|'|")/iu.exec(source.slice(index))
    if (quoted) {
      const { token, end } = pythonString(source, index, quoted[0])
      statement.tokens.push(token)
      index = end
      continue
    }
    const word = /^[a-z_]\w*/iu.exec(source.slice(index))?.[0]
    if (word) {
      statement.tokens.push({ value: word, kind: 'word' })
      index += word.length
      continue
    }
    if ('([{'.includes(character)) brackets.push(character)
    if (')]}'.includes(character) && brackets.pop() !== '([{'.charAt(')]}'.indexOf(character))) {
      throw new Error('Unbalanced Python source delimiters.')
    }
    statement.tokens.push({ value: character, kind: 'symbol' })
    index++
  }
  if (brackets.length) throw new Error('Unbalanced Python source delimiters.')
  if (statement.tokens.length) statements.push(statement)
  return statements
}

function pythonString(source: string, start: number, opening: string): { token: PythonToken; end: number } {
  const prefix = /^[a-z]*/iu.exec(opening)![0]
  const delimiter = opening.slice(prefix.length)
  const contentStart = start + opening.length
  for (let index = contentStart; index < source.length; index++) {
    if (source[index] === '\\') {
      index++
      continue
    }
    if (delimiter.length === 1 && source[index] === '\n') throw new Error('Unterminated Python string.')
    if (!source.startsWith(delimiter, index)) continue
    const text = source.slice(contentStart, index)
    const literal = !/[bf]/iu.test(prefix) && (!text.includes('\\') || /r/iu.test(prefix)) ? text : undefined
    return {
      token: {
        value: source.slice(start, index + delimiter.length),
        kind: 'string',
        ...(literal === undefined ? {} : { literal }),
      },
      end: index + delimiter.length,
    }
  }
  throw new Error('Unterminated Python string.')
}
