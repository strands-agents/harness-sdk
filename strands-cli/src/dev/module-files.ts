import type { HarnessAgentConfig, HarnessModuleReference } from '@strands-agents/harness'
import { builtinModules, createRequire } from 'node:module'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import ts from 'typescript'

import { mapWebFetchModelModule, webFetchModelModule } from '../agent/tools.js'
import { expandHome } from '../paths.js'
import { isRecord } from '../values.js'
import type { AgentProjectLanguage } from '../project/import.js'

const MAX_MODULE_FILES = 256
const MAX_MODULE_BYTES = 10 * 1024 * 1024
const NODE_MODULES = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')))
const CODE_EXTENSION = /\.[cm]?[jt]sx?$/iu

interface ModuleFiles {
  files: Set<string>
  dependencies: Record<string, string>
  bytes: number
}

const optionalFile = async (path: string): Promise<boolean> => {
  try {
    const details = await lstat(path)
    if (details.isSymbolicLink()) throw new Error(`A local module cannot use a symbolic link: ${path}`)
    return details.isFile()
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return false
    throw error
  }
}

const resolveSourceFile = async (path: string): Promise<string> => {
  const extension = extname(path)
  const candidates = [path]
  if (/\.[cm]?js$/u.test(extension)) candidates.push(path.replace(/\.([cm]?)js$/u, '.$1ts'))
  if (!extension) candidates.push(...['.ts', '.mts', '.js', '.mjs', '.json', '.py'].map((suffix) => `${path}${suffix}`))
  for (const candidate of candidates) {
    if (!(await optionalFile(candidate))) continue
    if ((await realpath(candidate)) !== candidate)
      throw new Error(`A local module path cannot contain a symbolic link: ${candidate}`)
    return candidate
  }
  throw new Error(`Cannot copy the local module file: ${path}`)
}

const packageName = (specifier: string): string =>
  specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!

const packageVersion = async (specifier: string, source: string): Promise<string> => {
  const name = packageName(specifier)
  for (const require of [createRequire(source), createRequire(import.meta.url)]) {
    let entrypoint: string
    try {
      entrypoint = require.resolve(specifier)
    } catch (error) {
      if (isRecord(error) && ['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(String(error.code)))
        continue
      throw error
    }
    for (let directory = dirname(entrypoint); dirname(directory) !== directory; directory = dirname(directory)) {
      const path = join(directory, 'package.json')
      if (!(await optionalFile(path))) continue
      const manifest: unknown = JSON.parse(await readFile(path, 'utf8'))
      if (isRecord(manifest) && manifest.name === name && typeof manifest.version === 'string') return manifest.version
    }
  }
  throw new Error(
    `Local module ${source} imports ${name}. Install it or declare dependencies.typescript[${JSON.stringify(name)}] in the profile.`
  )
}

const sourceReferences = (source: string, path: string): string[] => {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const references = new Set<string>()
  const add = (node: ts.Node | undefined): void => {
    if (!node || !ts.isStringLiteralLike(node))
      throw new Error(`Local module ${path} uses a dynamic import. Declare its files explicitly.`)
    references.add(node.text)
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier)
      add(node.moduleSpecifier)
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference))
      add(node.moduleReference.expression)
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      add(node.arguments[0])
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'URL' &&
      node.arguments?.[1]?.getText(file) === 'import.meta.url'
    ) {
      const argument = node.arguments[0]
      if (argument && ts.isStringLiteralLike(argument) && argument.text.startsWith('.')) references.add(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return [...references]
}

const includeModule = async (path: string, state: ModuleFiles): Promise<void> => {
  const sourcePath = await resolveSourceFile(path)
  if (state.files.has(sourcePath)) return
  const details = await lstat(sourcePath)
  state.bytes += details.size
  if (state.files.size >= MAX_MODULE_FILES || state.bytes > MAX_MODULE_BYTES)
    throw new Error('Local module files exceed the workspace copy limit.')
  state.files.add(sourcePath)
  if (!CODE_EXTENSION.test(sourcePath)) return
  for (const specifier of sourceReferences(await readFile(sourcePath, 'utf8'), sourcePath)) {
    if (specifier.startsWith('.')) {
      await includeModule(resolve(dirname(sourcePath), specifier), state)
    } else if (isAbsolute(specifier) || specifier.startsWith('file:')) {
      throw new Error(
        `Local module ${sourcePath} imports an absolute path. Use relative imports or declare a portable module explicitly.`
      )
    } else if (!specifier.startsWith('node:') && !NODE_MODULES.has(specifier)) {
      const name = packageName(specifier)
      state.dependencies[name] ??= await packageVersion(specifier, sourcePath)
    }
  }
}

const pythonModuleFiles = async (path: string, state: ModuleFiles): Promise<void> => {
  const sourcePath = await resolveSourceFile(path)
  if (state.files.has(sourcePath)) return
  const details = await lstat(sourcePath)
  state.bytes += details.size
  if (state.files.size >= MAX_MODULE_FILES || state.bytes > MAX_MODULE_BYTES)
    throw new Error('Local module files exceed the workspace copy limit.')
  state.files.add(sourcePath)
  const source = await readFile(sourcePath, 'utf8')
  for (const match of source.matchAll(/^\s*from\s+(\.*)([\w.]+)\s+import\s/gmu)) {
    let directory = dirname(sourcePath)
    for (let depth = 1; depth < match[1]!.length; depth++) directory = dirname(directory)
    const imported = join(directory, ...match[2]!.split('.'))
    if (await optionalFile(`${imported}.py`)) await pythonModuleFiles(`${imported}.py`, state)
    else if (match[1]) throw new Error(`Local Python module ${sourcePath} needs explicit files for ${match[0].trim()}.`)
  }
  const init = join(dirname(sourcePath), '__init__.py')
  if (basename(sourcePath) !== '__init__.py' && (await optionalFile(init))) await pythonModuleFiles(init, state)
}

export const withDevModuleFiles = async (
  profile: HarnessAgentConfig,
  baseDir: string,
  language: AgentProjectLanguage
): Promise<HarnessAgentConfig> => {
  const configured = globalThis.structuredClone(profile)
  const dependencies = configured.dependencies.typescript
  const references = [
    configured.modelModule,
    ...configured.tools,
    ...configured.subagents,
    ...configured.plugins,
    ...configured.memoryStores,
    ...configured.interventionModules,
    configured.sandbox,
    ...Object.values(configured.agentConfigModules),
    webFetchModelModule(configured.builtinTools),
  ]
  const mapped = new Map<HarnessModuleReference, HarnessModuleReference>()
  for (const reference of references) {
    if (
      !reference ||
      reference.files?.length ||
      !(reference.module.startsWith('.') || isAbsolute(expandHome(reference.module)))
    )
      continue
    if (reference.language && reference.language !== language) continue
    const module = resolve(baseDir, expandHome(reference.module))
    const state: ModuleFiles = { files: new Set(), dependencies, bytes: 0 }
    if (language === 'python') await pythonModuleFiles(module, state)
    else await includeModule(module, state)
    const updated = { ...reference, module, files: [...state.files] }
    mapped.set(reference, updated)
    Object.assign(reference, updated)
  }
  configured.builtinTools = mapWebFetchModelModule(
    configured.builtinTools,
    (reference) => mapped.get(reference) ?? reference
  )
  return configured
}
