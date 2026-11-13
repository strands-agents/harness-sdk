import { access, readFile } from 'node:fs/promises'
import type { LoadHook, ResolveHook } from 'node:module'
import { extname } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import ts from 'typescript'

let runtimeParent: string
let projectRoot: string
let runtimeSdkRoot: string
let entrypoint: string
let localHarness: string | undefined
const VERSION_PARAMETER = 'load'

export function initialize(data: {
  runtimeParent: string
  projectRoot: string
  runtimeSdkRoot: string
  entrypoint: string
  localHarness?: string
}): void {
  runtimeParent = data.runtimeParent
  projectRoot = data.projectRoot
  runtimeSdkRoot = data.runtimeSdkRoot
  entrypoint = data.entrypoint
  localHarness = data.localHarness
}

export const load: LoadHook = async (url, context, nextLoad) => {
  const path = new URL(url)
  path.search = ''
  if (path.href !== entrypoint) {
    return nextLoad(url, context)
  }
  const source = await readFile(path, 'utf8')
  const file = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const statement = file.statements.find(
    (node) =>
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.some((declaration) => declaration.name.getText(file) === 'agent')
  )
  const declaration =
    statement && ts.isVariableStatement(statement) && statement.declarationList.declarations.length === 1
      ? statement.declarationList.declarations[0]
      : undefined
  const expression = declaration?.initializer
  const call = expression && ts.isAwaitExpression(expression) ? expression.expression : expression
  if (!statement || !call || !ts.isCallExpression(call) || call.arguments.length > 1) {
    throw new Error('Export an agent constructed with createHarness(...) from agent.ts.')
  }
  const configLoaders = new Set(
    file.statements.flatMap((node) =>
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === '@strands-agents/harness' &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
        ? node.importClause.namedBindings.elements
            .filter((item) => (item.propertyName ?? item.name).text === 'harnessAgentOptionsFromConfig')
            .map((item) => item.name.text)
        : []
    )
  )
  const transformed = ts.transform(file, [
    (context) => {
      const visit = (node: ts.Node): ts.VisitResult<ts.Node> => {
        const updated = ts.visitEachChild(node, visit, context)
        if (!ts.isCallExpression(updated)) return updated
        if (node === call) {
          return ts.factory.updateCallExpression(
            updated,
            ts.factory.createIdentifier('__strandsConstruct'),
            undefined,
            [updated.expression, updated.arguments[0] ?? ts.factory.createObjectLiteralExpression()]
          )
        }
        if (
          ts.isIdentifier(updated.expression) &&
          configLoaders.has(updated.expression.text) &&
          updated.arguments.length === 1
        ) {
          return ts.factory.updateCallExpression(updated, updated.expression, updated.typeArguments, [
            ...updated.arguments,
            ts.factory.createStringLiteral(fileURLToPath(projectRoot)),
          ])
        }
        return updated
      }
      return (root): ts.SourceFile => ts.visitNode(root, visit, ts.isSourceFile)!
    },
  ])
  // Pause only the constructor call; the rest of the authored module keeps its scope.
  const prepared = [
    `import { constructProjectAgent as __strandsConstruct } from ${JSON.stringify(runtimeParent)}`,
    ts.createPrinter().printFile(transformed.transformed[0]!),
    'export { agent as __strandsAgent }',
  ].join('\n')
  transformed.dispose()
  return transpile(path, prepared)
}

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  const input = sourceUrl(specifier)
  if (localHarness && input.url.startsWith('file:')) {
    const url = new URL(input.url)
    const sdkPath = url.pathname.match(/\/node_modules\/@strands-agents\/sdk\/(.+)$/u)?.[1]
    if (sdkPath) {
      const shared = new URL(sdkPath, new URL('../../', runtimeSdkRoot))
      return nextResolve(shared.href, context)
    }
  }
  const parent = context.parentURL ? sourceUrl(context.parentURL) : undefined
  const version = input.version ?? parent?.version
  const resolutionContext = parent ? { ...context, parentURL: parent.url } : context
  const workspaceParent = parent?.url.startsWith(projectRoot)
  if (
    localHarness &&
    workspaceParent &&
    (input.url === '@strands-agents/harness' || input.url.startsWith('@strands-agents/harness/'))
  ) {
    const file =
      input.url === '@strands-agents/harness'
        ? 'src/index.ts'
        : input.url === '@strands-agents/harness/internal'
          ? 'src/internal.ts'
          : undefined
    if (!file) throw new Error(`Unsupported local harness export: ${input.url}`)
    const url = new URL(file, localHarness)
    await access(url)
    if (version) url.searchParams.set(VERSION_PARAMETER, version)
    return { url: url.href, shortCircuit: true }
  }
  const hostPackage = ['@strands-agents/harness', '@strands-agents/sdk'].some(
    (name) => input.url === name || input.url.startsWith(`${name}/`)
  )
  let resolved: Awaited<ReturnType<ResolveHook>>
  try {
    resolved = await nextResolve(
      input.url,
      hostPackage && parent?.url.startsWith(projectRoot)
        ? { ...resolutionContext, parentURL: runtimeParent }
        : resolutionContext
    )
  } catch (error) {
    if (
      localHarness &&
      parent?.url.startsWith(localHarness) &&
      !input.url.startsWith('.') &&
      !input.url.includes(':') &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_MODULE_NOT_FOUND'
    ) {
      return nextResolve(input.url, { ...resolutionContext, parentURL: runtimeParent })
    }
    const providerPackage = ['openai', '@anthropic-ai/sdk', '@google/genai'].some(
      (name) => input.url === name || input.url.startsWith(`${name}/`)
    )
    if (
      providerPackage &&
      parent?.url.startsWith(runtimeSdkRoot) &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'ERR_MODULE_NOT_FOUND'
    ) {
      resolved = await nextResolve(input.url, { ...resolutionContext, parentURL: `${projectRoot}package.json` })
    } else {
      const fallback = await typescriptFallback(input.url, parent?.url)
      if (!fallback) throw error
      resolved = { url: fallback, shortCircuit: true }
    }
  }
  if (!version || !isProjectModule(resolved.url)) return resolved
  const url = new URL(resolved.url)
  url.searchParams.set(VERSION_PARAMETER, version)
  return { ...resolved, url: url.href }
}

function transpile(path: URL, source: string): ReturnType<LoadHook> {
  return {
    format: 'module',
    shortCircuit: true,
    source: ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      fileName: path.pathname,
    }).outputText,
  }
}

function sourceUrl(value: string): { url: string; version: string | null } {
  if (!value.startsWith('file:')) return { url: value, version: null }
  const url = new URL(value)
  const version = url.searchParams.get(VERSION_PARAMETER)
  url.searchParams.delete(VERSION_PARAMETER)
  return { url: url.href, version }
}

function isProjectModule(url: string): boolean {
  return url.startsWith(projectRoot) && !new URL(url).pathname.split('/').includes('node_modules')
}

async function typescriptFallback(specifier: string, parent?: string): Promise<string | undefined> {
  if (!parent || (!specifier.startsWith('.') && !specifier.startsWith('file:'))) return undefined
  const url = new URL(specifier, parent)
  if (!isProjectModule(url.href)) return undefined
  const extension = extname(url.pathname)
  const replacement = {
    '.js': '.ts',
    '.jsx': '.tsx',
    '.mjs': '.mts',
    '.cjs': '.cts',
  }[extension]
  if (!replacement) return undefined
  url.pathname = `${url.pathname.slice(0, -extension.length)}${replacement}`
  try {
    await access(fileURLToPath(url))
    return url.href
  } catch {
    return undefined
  }
}
