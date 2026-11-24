import { randomUUID } from 'node:crypto'
import { renameSync, rmSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { HarnessAgentConfig, HarnessModuleReference } from '@strands-agents/harness'
import ts from 'typescript'

import { resolveSkillPaths } from '../agent/skills.js'
import { mapWebFetchModelModule, webFetchModelModule } from '../agent/tools.js'
import { savedAgentProject, type CliConfigSnapshot } from '../config/store.js'
import { containsPath, expandHome } from '../paths.js'
import { errorMessage } from '../terminal/text.js'
import { importAgentProject, type AgentProjectLanguage } from '../project/import.js'
import { installAgentProject, installProjectDependencies, type ProjectInstallation } from '../project/install.js'
import { moduleLanguage } from '../project/portability.js'
import { isRecord } from '../values.js'
import {
  bindWorkspace,
  boundDevWorkspace,
  optionalDetails,
  readDevWorkspace,
  WORKSPACE_FOLDER,
  type DevWorkspace,
} from './workspace.js'

interface CreateDevWorkspaceOptions {
  destination: string
  kind: 'cli' | 'typescript' | 'python'
  snapshot: CliConfigSnapshot
  cwd: string
  signal?: AbortSignal
  deferDependencies?: boolean
}

interface CreateDevProjectOptions {
  language: 'typescript' | 'python'
  snapshot: CliConfigSnapshot
  cwd: string
  signal?: AbortSignal
  deferDependencies?: boolean
}

type DestinationClaim = 'created' | 'empty'

const PROJECT_FOLDER = 'strands-workspace'

export const projectFolder = (parent: string): string => join(parent, PROJECT_FOLDER)

const LANGUAGE_NAMES: Record<AgentProjectLanguage, string> = { typescript: 'TypeScript', python: 'Python' }

const foreignModelModule = (snapshot: CliConfigSnapshot, language: AgentProjectLanguage): string | undefined => {
  const reference = snapshot.profile.modelModule
  const written = reference && moduleLanguage(reference)
  return written && written !== language ? reference.module : undefined
}

export const newProjectModelNotice = (
  snapshot: CliConfigSnapshot,
  language: AgentProjectLanguage
): string | undefined => {
  const module = foreignModelModule(snapshot, language)
  return (
    module &&
    `${LANGUAGE_NAMES[language]} cannot load the model module ${basename(module)}. The new harness uses ${snapshot.profile.model}.`
  )
}

const ABSENT_PATH_CODES = new Set(['ENOENT', 'ENOTDIR'])

const presentSkillSources = async (paths: readonly string[]): Promise<string[]> => {
  const absent = await Promise.all(
    paths.map(async (path) =>
      path.startsWith('https://')
        ? false
        : lstat(path).then(
            () => false,
            (error: unknown) => ABSENT_PATH_CODES.has((error as NodeJS.ErrnoException).code ?? '')
          )
    )
  )
  return paths.filter((_, index) => !absent[index])
}

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

const addModuleFile = async (path: string, state: ModuleFiles): Promise<string | undefined> => {
  const sourcePath = await resolveSourceFile(path)
  if (state.files.has(sourcePath)) return undefined
  const details = await lstat(sourcePath)
  state.bytes += details.size
  if (state.files.size >= MAX_MODULE_FILES || state.bytes > MAX_MODULE_BYTES)
    throw new Error('Local module files exceed the workspace copy limit.')
  state.files.add(sourcePath)
  return sourcePath
}

const includeModule = async (path: string, state: ModuleFiles): Promise<void> => {
  const sourcePath = await addModuleFile(path, state)
  if (!sourcePath || !CODE_EXTENSION.test(sourcePath)) return
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
  const sourcePath = await addModuleFile(path, state)
  if (!sourcePath) return
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

export const profileProject = async (
  snapshot: CliConfigSnapshot,
  cwd: string,
  language: AgentProjectLanguage
): Promise<Omit<Extract<ProjectInstallation, { profile: unknown }>, 'destination'>> => {
  const baseDir = snapshot.profileBaseDir ?? cwd
  const source = foreignModelModule(snapshot, language) ? { ...snapshot.profile, modelModule: null } : snapshot.profile
  const profile = await withDevModuleFiles(source, baseDir, language)
  const skills = await presentSkillSources(
    resolveSkillPaths(typeof profile.skills === 'object' ? [...profile.skills] : profile.skills, baseDir, false)
  )
  return { profile, language, skills, baseDir }
}

const portableEntrypoint = (root: string, entrypoint: string): string => relative(root, entrypoint).split(sep).join('/')

const claimDestination = async (path: string): Promise<DestinationClaim> => {
  const details = await optionalDetails(path)
  if (!details) {
    await mkdir(dirname(path), { recursive: true })
    await mkdir(path, { mode: 0o700 })
    return 'created'
  }
  if (details.isDirectory() && (await readdir(path)).length === 0) return 'empty'
  throw new Error(
    `The destination already exists: ${path}. Choose a new workspace path or open the existing workspace.`
  )
}

const releaseDestination = async (path: string, claim: DestinationClaim): Promise<void> => {
  if (claim === 'created') return rm(path, { recursive: true, force: true })
  const entries = await readdir(path).catch(() => [])
  await Promise.all(entries.map((entry) => rm(join(path, entry), { recursive: true, force: true })))
}

export interface FolderClaims {
  claim(path: string): Promise<void>
  claimCreated(path: string): void
  replace(path: string, outside?: string): Promise<void>
  release(): Promise<void>
  commit(): Promise<void>
}

interface Replacement {
  path: string
  backup: string
}

interface FolderClaim {
  path: string
  claim: DestinationClaim
  missingParents: readonly string[]
}

const missingParents = async (path: string): Promise<string[]> => {
  const parents: string[] = []
  for (
    let parent = dirname(path);
    parent !== dirname(parent) && !(await optionalDetails(parent));
    parent = dirname(parent)
  )
    parents.push(parent)
  return parents
}

const isEmptyFolder = async (path: string): Promise<boolean> =>
  (await lstat(path)).isDirectory() && (await readdir(path)).length === 0

const removeEmptyFolder = async (path: string): Promise<boolean> => {
  try {
    await rmdir(path)
    return true
  } catch (error) {
    if (['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  }
}

const releaseClaim = async ({ path, claim, missingParents }: FolderClaim): Promise<void> => {
  await releaseDestination(path, claim)
  for (const parent of missingParents) if (!(await removeEmptyFolder(parent))) return
}

const restoreReplacement = async ({ path, backup }: Replacement): Promise<void> => {
  await rm(path, { recursive: true, force: true })
  await rename(backup, path)
}

const settle = async <Item>(
  items: Item[],
  action: (item: Item) => Promise<void>,
  failure: (item: Item, error: unknown) => string
): Promise<string[]> => {
  const failures: string[] = []
  for (const item of [...items].reverse()) {
    try {
      await action(item)
      items.splice(items.indexOf(item), 1)
    } catch (error) {
      failures.push(failure(item, error))
    }
  }
  return failures
}

const notDeleted = ({ path }: FolderClaim, error: unknown): string => `Could not delete ${path}: ${errorMessage(error)}`
const notRestored = ({ path, backup }: Replacement, error: unknown): string =>
  `Could not restore ${path}: ${errorMessage(error)}. The old folder is kept at ${backup}`
const backupKept = ({ backup }: Replacement, error: unknown): string =>
  `Could not delete the replaced workspace kept at ${backup}: ${errorMessage(error)}`

const restoreBeforeExit = (replacements: Replacement[]): void => {
  for (const replacement of replacements.splice(0).reverse()) {
    try {
      rmSync(replacement.path, { recursive: true, force: true })
      renameSync(replacement.backup, replacement.path)
    } catch (error) {
      process.stderr.write(`${notRestored(replacement, error)}\n`)
    }
  }
}

const backupPath = (path: string, parent: string): string => join(parent, `.${basename(path)}-${randomUUID()}.replaced`)

const refuseSavedAgentFolder = async (path: string): Promise<void> => {
  const saved = await savedAgentProject()
  if (saved && containsPath(path, resolve(saved)))
    throw new Error(
      `Plain strands uses the agent ${saved}, which is in ${path}. Choose another workspace folder, or point plain strands at another agent first.`
    )
}

const setAside = async (path: string, outside: string | undefined): Promise<string> => {
  if (outside) {
    const backup = backupPath(path, outside)
    const moved = await rename(path, backup).then(
      () => true,
      () => false
    )
    if (moved) return backup
  }
  const backup = backupPath(path, dirname(path))
  await rename(path, backup)
  return backup
}

export const folderClaims = (): FolderClaims => {
  const claims: FolderClaim[] = []
  const replacements: Replacement[] = []
  const record = (claim: FolderClaim): void => {
    if (!claims.some((held) => containsPath(held.path, claim.path))) claims.push(claim)
  }
  const restoreOnExit = (): void => restoreBeforeExit(replacements)
  return {
    claim: async (path): Promise<void> => {
      if (!(await optionalDetails(path))) record({ path, claim: 'created', missingParents: await missingParents(path) })
      else if (await isEmptyFolder(path)) record({ path, claim: 'empty', missingParents: [] })
    },
    claimCreated: (path): void => record({ path, claim: 'created', missingParents: [] }),
    replace: async (path, outside): Promise<void> => {
      await refuseSavedAgentFolder(path)
      const backup = await setAside(path, outside)
      if (!replacements.length) process.once('exit', restoreOnExit)
      replacements.push({ path, backup })
    },
    release: async (): Promise<void> => {
      const failures = [
        ...(await settle(claims, releaseClaim, notDeleted)),
        ...(await settle(replacements, restoreReplacement, notRestored)),
      ]
      if (!replacements.length) process.removeListener('exit', restoreOnExit)
      if (failures.length) throw new Error(failures.join('; '))
    },
    commit: async (): Promise<void> => {
      process.removeListener('exit', restoreOnExit)
      claims.splice(0)
      const failures = await settle(
        replacements,
        ({ backup }) => rm(backup, { recursive: true, force: true }),
        backupKept
      )
      replacements.splice(0)
      if (failures.length) throw new Error(failures.join('; '))
    },
  }
}

export const createDevWorkspace = async (options: CreateDevWorkspaceOptions): Promise<DevWorkspace> => {
  options.signal?.throwIfAborted()
  const destination = resolve(options.cwd, options.destination)
  const existing = await readDevWorkspace(destination)
  if (existing) return existing
  const claim = await claimDestination(destination)
  try {
    const origin = {
      kind: options.kind === 'cli' ? ('cli' as const) : ('created' as const),
      source: options.snapshot.agentProject ?? options.snapshot.path,
    }
    if (options.kind === 'cli' && options.snapshot.agentProject) {
      const project = importAgentProject(options.snapshot.agentProject)
      await bindWorkspace(destination, {
        version: 1,
        name: options.snapshot.profile.name,
        agent: {
          path: project.root,
          entrypoint: portableEntrypoint(project.root, project.entrypoint),
          language: project.language,
        },
        origin,
      })
    } else {
      const language = options.kind === 'python' ? 'python' : 'typescript'
      const project = await installAgentProject({
        destination: join(destination, 'agent'),
        ...(options.deferDependencies ? { deferDependencies: true } : {}),
        ...(await profileProject(options.snapshot, options.cwd, language)),
        ...(options.signal ? { signal: options.signal } : {}),
      })
      await bindWorkspace(destination, {
        version: 1,
        name: options.snapshot.profile.name,
        agent: { path: 'agent', entrypoint: portableEntrypoint(project.root, project.entrypoint), language },
        origin,
      })
    }
    options.signal?.throwIfAborted()
    const workspace = await readDevWorkspace(destination)
    if (!workspace) throw new Error(`Workspace binding is missing in ${destination}.`)
    return workspace
  } catch (error) {
    await releaseDestination(destination, claim)
    throw error
  }
}

export const createDevProject = async (options: CreateDevProjectOptions): Promise<DevWorkspace> => {
  options.signal?.throwIfAborted()
  const input = await profileProject(options.snapshot, options.cwd, options.language)
  const root = projectFolder(resolve(options.cwd))
  const project = await installAgentProject({
    destination: root,
    deferDependencies: true,
    placement: 'project-root',
    ...input,
  })
  try {
    options.signal?.throwIfAborted()
    if (!options.deferDependencies) await installProjectDependencies(project)
    const directory = join(root, WORKSPACE_FOLDER)
    await mkdir(directory, { mode: 0o700 })
    await bindWorkspace(directory, {
      version: 1,
      name: options.snapshot.profile.name,
      agent: {
        path: '..',
        entrypoint: portableEntrypoint(project.root, project.entrypoint),
        language: options.language,
      },
      origin: { kind: 'created', source: options.snapshot.agentProject ?? options.snapshot.path },
    })
    options.signal?.throwIfAborted()
    const workspace = await readDevWorkspace(directory)
    if (!workspace) throw new Error(`Workspace binding is missing in ${directory}.`)
    return workspace
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

export const bindExistingAgent = async (destination: string, path: string): Promise<DevWorkspace> => {
  const project = importAgentProject(path)
  await mkdir(destination, { recursive: true })
  const legacy = await readDevWorkspace(project.root)
  return boundDevWorkspace(
    await bindWorkspace(destination, {
      version: 1,
      name: legacy?.config.name ?? basename(project.root),
      agent: {
        path: project.root,
        entrypoint: portableEntrypoint(project.root, project.entrypoint),
        language: project.language,
      },
      origin: { kind: 'discovered', source: project.entrypoint },
      ...(legacy?.config.harness ? { harness: legacy.config.harness } : {}),
    })
  )
}
