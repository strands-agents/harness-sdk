import { Buffer } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import {
  createRequire,
  type LoadHook,
  type LoadHookContext,
  type LoadHookSync,
  type ResolveHook,
  type ResolveHookContext,
  type ResolveHookSync,
} from 'node:module'
import { dirname, extname, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TextDecoder } from 'node:util'
import { init, parse } from 'cjs-module-lexer'
import { transform } from 'esbuild'
import { resolve as resolveImport } from 'import-meta-resolve'

let projectRoot: string
let runtimeParent: string
let hostDirectories: string[]
const reloadProtocol = 'source-reload:'
const hostModulesKey = Symbol.for('harness.config.hostModules')

export async function shareHostModules(parent: string): Promise<void> {
  const globals = globalThis as typeof globalThis & {
    [hostModulesKey]?: Map<string, Map<string, Record<string, unknown>>>
  }
  const hosts = (globals[hostModulesKey] ??= new Map())
  if (!hosts.has(parent)) {
    // Node 20/22's async CommonJS loader cannot require an existing ESM job.
    const modules = await Promise.all(
      ['@strands-agents/sdk', '@strands-agents/harness'].map(
        async (name): Promise<[string, Record<string, unknown>]> => [name, await import(resolveImport(name, parent))]
      )
    )
    hosts.set(parent, new Map(modules))
  }
}

export function initialize(data: { projectRoot: string; runtimeParent: string }): void {
  projectRoot = data.projectRoot
  runtimeParent = data.runtimeParent
  hostDirectories = [
    new URL('./', runtimeParent).href,
    ...['@strands-agents/sdk', '@strands-agents/harness'].map(
      (name) => new URL('./', resolveImport(name, runtimeParent)).href
    ),
  ]
}

export function isHostPackage(specifier: string): boolean {
  return ['@strands-agents/sdk', '@strands-agents/harness'].some(
    (name) => specifier === name || specifier.startsWith(`${name}/`)
  )
}

function reloadModuleUrl(url: string, generation: string): string {
  return `${reloadProtocol}//${generation}/${Buffer.from(url).toString('base64url')}`
}

function reloadSourceUrl(value: string, generation: string): string {
  const url = new URL(value)
  url.hash = `source_reload=${generation}`
  return url.href
}

export function resolveReloadUrl(
  specifier: string,
  context: ResolveHookContext,
  nextResolve: Parameters<ResolveHookSync>[2]
): ReturnType<ResolveHookSync> {
  const input = specifier.startsWith('file:') ? sourceUrl(specifier) : undefined
  // Keep tsx's synchronous resolver from stripping the reload marker before the async hook sees it.
  return nextResolve(input?.generation ? reloadModuleUrl(input.url, input.generation) : specifier, context)
}

export function canonicalCommonJsLoader(root: string, parent: string): LoadHookSync {
  return (url, context, nextLoad) => {
    const result = nextLoad(url, context)
    if (
      !url.startsWith(root) ||
      new URL(url).pathname.split('/').includes('node_modules') ||
      !result.format?.startsWith('commonjs') ||
      result.source == null
    ) {
      return result
    }
    const source = typeof result.source === 'string' ? result.source : new TextDecoder().decode(result.source)
    // Run after tsx's synchronous transform, which can replace an async hook's CommonJS source.
    return { format: 'commonjs', source: commonJsSource(source, url, new Set(), false, parent) }
  }
}

function sourceUrl(value: string): { url: string; generation: string | null } {
  const url = new URL(value)
  if (url.protocol === reloadProtocol) {
    return { url: Buffer.from(url.pathname.slice(1), 'base64url').toString(), generation: url.hostname }
  }
  const generation = url.hash.startsWith('#source_reload=') ? url.hash.slice('#source_reload='.length) : null
  if (url.hash.startsWith('#source_reload=')) url.hash = ''
  return { url: url.href, generation }
}

export async function resolve(
  specifier: string,
  context: ResolveHookContext,
  nextResolve: Parameters<ResolveHook>[2]
): Promise<Awaited<ReturnType<ResolveHook>>> {
  const parent = context.parentURL ? sourceUrl(context.parentURL) : undefined
  const input = specifier.startsWith(reloadProtocol) || specifier.startsWith('file:') ? sourceUrl(specifier) : undefined
  const generation = input?.generation ?? parent?.generation
  const shared = isHostPackage(specifier) && (generation || parent?.url.startsWith(projectRoot))
  // Authored plugins must share the host's SDK classes for instanceof checks and tool registration.
  const resolved = await nextResolve(
    shared ? resolveImport(specifier, runtimeParent) : (input?.url ?? specifier),
    parent
      ? { ...context, parentURL: parent.generation ? reloadSourceUrl(parent.url, parent.generation) : parent.url }
      : context
  )
  if (
    generation &&
    !shared &&
    resolved.url.startsWith('file:') &&
    !new URL(resolved.url).pathname.split('/').includes('node_modules') &&
    !hostDirectories.some((directory) => resolved.url.startsWith(directory)) &&
    (input ||
      specifier.startsWith('.') ||
      specifier.startsWith('file:') ||
      specifier.startsWith('#') ||
      isAbsolute(specifier))
  ) {
    // CommonJS caches by filename, so URL metadata cannot isolate an edited module or its requires.
    if (resolved.format?.startsWith('commonjs') || resolved.format === 'json') {
      return { ...resolved, url: reloadModuleUrl(resolved.url, generation) }
    }
    return { ...resolved, url: reloadSourceUrl(resolved.url, generation) }
  }
  return resolved
}

export async function load(
  url: string,
  context: LoadHookContext,
  nextLoad: Parameters<LoadHook>[2]
): Promise<Awaited<ReturnType<LoadHook>> & { responseURL?: string }> {
  const isolated = url.startsWith(reloadProtocol)
  if (
    !isolated &&
    (!url.startsWith(projectRoot) ||
      new URL(url).pathname.split('/').includes('node_modules') ||
      hostDirectories.some((directory) => url.startsWith(directory)))
  ) {
    return nextLoad(url, context)
  }
  const original = isolated ? sourceUrl(url).url : url
  if (isolated && context.format === 'json') {
    return {
      format: 'commonjs',
      responseURL: url,
      source: `module.exports = JSON.parse(${JSON.stringify(await readFile(new URL(original), 'utf8'))})`,
      shortCircuit: true,
    }
  }
  const result = await nextLoad(original, context)
  const commonjs = (result.format ?? context.format)?.startsWith('commonjs')
  if (!isolated && !commonjs) {
    return result
  }
  const content = result.source ?? (await readFile(new URL(original)))
  const source = typeof content === 'string' ? content : new TextDecoder().decode(content)
  const compiled = commonjs ? await compileCommonJs(source, original) : source
  const names = commonjs ? await commonJsExports(compiled, original, new Set()) : new Set<string>()
  return {
    ...result,
    ...(commonjs ? { format: 'commonjs' } : {}),
    responseURL: url,
    source: commonjs ? commonJsSource(compiled, original, names, isolated) : compiled,
  }
}

async function compileCommonJs(source: string, url: string): Promise<string> {
  const filename = fileURLToPath(url)
  const result = await transform(source, {
    sourcefile: filename,
    loader: filename.endsWith('.tsx') ? 'tsx' : /\.[cm]?ts$/u.test(filename) ? 'ts' : 'js',
    format: 'cjs',
    target: 'es2022',
    keepNames: true,
  })
  return result.code
}

async function commonJsExports(source: string, url: string, visited: Set<string>): Promise<Set<string>> {
  await init()
  visited.add(url)
  const { exports, reexports } = parse(source)
  const names = new Set(exports)
  for (const specifier of reexports) {
    try {
      const filename = createRequire(isHostPackage(specifier) ? runtimeParent : url).resolve(specifier)
      if (!isAbsolute(filename) || ['.json', '.node'].includes(extname(filename))) continue
      const child = pathToFileURL(filename).href
      if (visited.has(child)) continue
      const compiled = await compileCommonJs(await readFile(filename, 'utf8'), child)
      for (const name of await commonJsExports(compiled, child, visited)) names.add(name)
    } catch {
      // Node ignores unresolved re-export hints; executing the require still reports any module error.
    }
  }
  return names
}

function commonJsSource(
  source: string,
  url: string,
  names: Set<string>,
  isolated: boolean,
  parent = runtimeParent
): string {
  const filename = JSON.stringify(fileURLToPath(url))
  const directory = JSON.stringify(dirname(fileURLToPath(url)))
  // Preserve authored path metadata and directives; only local requires enter the isolated graph.
  return `require = ((authored) => {
  const { createRequire } = authored('node:module')
  const { isAbsolute } = authored('node:path')
  const local = createRequire(${JSON.stringify(url)})
  const host = createRequire(${JSON.stringify(parent)})
  const shared = globalThis[Symbol.for('harness.config.hostModules')]?.get(${JSON.stringify(parent)})
  const from = (specifier) => /^@strands-agents\\/(sdk|harness)(\\/|$)/u.test(specifier) ? host : local
  const require = Object.assign((specifier) => {
    if (shared?.has(specifier)) return shared.get(specifier)
    if (from(specifier) === host) {
      try {
        return authored(host.resolve(specifier))
      } catch (error) {
        throw new Error('Cannot require ' + specifier + ' from a CommonJS module on ' + process.version +
          '. Use an ESM module (.mjs or .mts) with import instead.', { cause: error })
      }
    }
    if (specifier.startsWith('.') || specifier.startsWith('#') || isAbsolute(specifier)) {
      const filename = local.resolve(specifier)
      return ${isolated} || !filename.endsWith('.json') ? authored(filename) : local(filename)
    }
    return local(specifier)
  }, local, {
    resolve: Object.assign((specifier, options) => from(specifier).resolve(specifier, options), local.resolve)
  })
  module.filename = ${filename}
  module.path = ${directory}
  module.require = require
  return require
})(require)
;(function (exports, require, module, __filename, __dirname) {
${source.replace(/^#![^\n]*(?:\n|$)/u, '')}
}).call(this, exports, require, module, ${filename}, ${directory})
${names.size ? `0 && (module.exports = { ${[...names].map((name) => `${JSON.stringify(name)}: null`).join(', ')} })` : ''}
`
}
