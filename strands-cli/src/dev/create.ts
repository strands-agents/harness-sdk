import { normalizeHarnessAgentConfig } from '@strands-agents/harness/internal'
import type { HarnessAgentConfig } from '@strands-agents/harness'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { resolveSkillPaths } from '../agent/skills.js'
import type { CliConfigSnapshot } from '../config/store.js'
import { exportSourceProject, prepareAgentProject, writeAgentProject } from '../project/export.js'
import { agentProjectSource } from '../project/source.js'
import { importAgentProject } from '../project/import.js'
import { isRecord } from '../values.js'
import { copyHarnessSource } from './harness-source.js'
import { initializeDevWorkspace, readDevWorkspace, type DevWorkspace } from './workspace.js'

export interface CreateDevWorkspaceOptions {
  destination: string
  kind: 'cli' | 'typescript' | 'python'
  snapshot: CliConfigSnapshot
  cwd: string
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const devProfile = (profile: HarnessAgentConfig): HarnessAgentConfig => {
  const { session, memory } = profile
  return normalizeHarnessAgentConfig({
    ...profile,
    session:
      session === false
        ? false
        : { ...(typeof session === 'object' ? session : {}), id: undefined, dir: './.strands/state/sessions' },
    memory:
      memory === false ? false : { ...(typeof memory === 'object' ? memory : {}), dir: './.strands/state/memory' },
  })
}

const configureLocalDependency = async (root: string, version: string): Promise<void> => {
  const path = join(root, 'package.json')
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!isRecord(parsed)) throw new Error(`Invalid package.json in ${root}.`)
  const dependencies = isRecord(parsed.dependencies) ? parsed.dependencies : {}
  parsed.dependencies = { ...dependencies, '@strands-agents/harness': 'file:./harness' }
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`)
  const harnessPath = join(root, 'harness', 'package.json')
  const harness = JSON.parse(await readFile(harnessPath, 'utf8')) as Record<string, unknown>
  if (harness.version !== version) throw new Error('The local harness version does not match its source.')
  harness.exports = { '.': './src/index.ts', './internal': './src/internal.ts' }
  await writeFile(harnessPath, `${JSON.stringify(harness, null, 2)}\n`)
}

interface CreatedProject {
  entrypoint: string
  language: 'typescript' | 'python'
  harness?: { path: string; version: string }
}

const writeFreshProject = async (root: string, options: CreateDevWorkspaceOptions): Promise<CreatedProject> => {
  const language = options.kind === 'python' ? 'python' : 'typescript'
  const baseDir = options.snapshot.profileBaseDir ?? options.cwd
  const profile = options.snapshot.profile
  const skills = resolveSkillPaths(
    typeof profile.skills === 'object' ? [...profile.skills] : profile.skills,
    baseDir,
    options.snapshot.settings.skillDiscovery
  )
  await writeAgentProject(profile, language, skills, root, baseDir, false, 'directory')
  const prepared = prepareAgentProject(profile, language, skills, baseDir)
  const filename = `agent.${language === 'python' ? 'py' : 'ts'}`
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', filename), agentProjectSource(devProfile(prepared.config), language))
  await rm(join(root, 'agent', filename))
  if (language === 'typescript') {
    const configPath = join(root, 'tsconfig.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      include: string[]
      compilerOptions: Record<string, unknown>
    }
    config.include = ['src/**/*', 'agent/**/*']
    config.compilerOptions.noImplicitAny = true
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)
  }
  const readmePath = join(root, 'README.md')
  await writeFile(
    readmePath,
    (await readFile(readmePath, 'utf8'))
      .replaceAll(`agent/${filename}`, `src/${filename}`)
      .replaceAll('.agent/', '.strands/state/')
  )
  return { entrypoint: `src/agent.${language === 'python' ? 'py' : 'ts'}`, language }
}

export const createDevWorkspace = async (options: CreateDevWorkspaceOptions): Promise<DevWorkspace> => {
  const destination = resolve(options.cwd, options.destination)
  const existing = await readDevWorkspace(destination)
  if (existing) return existing
  if (await exists(destination))
    throw new Error(
      `The destination already exists: ${destination}. Choose an empty destination or open it with --agent.`
    )
  await mkdir(dirname(destination), { recursive: true })
  const staging = join(dirname(destination), `.${basename(destination)}-${randomUUID()}`)
  try {
    const sourceProject =
      options.kind === 'cli' && options.snapshot.agentProject
        ? importAgentProject(options.snapshot.agentProject)
        : undefined
    const project = sourceProject
      ? await copyDefaultProject(sourceProject, staging, options.snapshot.profile.name)
      : await writeFreshProject(staging, options)
    const source =
      project.harness ??
      (options.kind === 'cli' && project.language === 'typescript'
        ? { ...(await copyHarnessSource(join(staging, 'harness'))), path: 'harness' }
        : undefined)
    if (source) await configureLocalDependency(staging, source.version)
    await initializeDevWorkspace(staging, {
      version: 1,
      name: options.snapshot.profile.name,
      language: project.language,
      entrypoint: project.entrypoint,
      origin: {
        kind: options.kind === 'cli' ? 'cli' : 'created',
        source: options.snapshot.agentProject ?? options.snapshot.path,
        ...(source ? { version: source.version } : {}),
      },
      ...(source ? { harness: { path: 'harness', version: source.version } } : {}),
    })
    await writeFile(join(staging, '.strands-entrypoint'), `./${project.entrypoint}\n`)
    await rename(staging, destination)
    const workspace = await readDevWorkspace(destination)
    if (!workspace) throw new Error(`Workspace metadata is missing in ${destination}.`)
    return workspace
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

const copyDefaultProject = async (
  project: ReturnType<typeof importAgentProject>,
  destination: string,
  name: string
): Promise<CreatedProject> => {
  const workspace = await readDevWorkspace(project.root)
  await exportSourceProject(
    project,
    name,
    project.language,
    ['.strands/state', '.strands/reports'],
    destination,
    'directory'
  )
  await rm(join(destination, '.strands'), { recursive: true, force: true })
  if (workspace?.config.harness && workspace.config.harness.path !== 'harness') {
    throw new Error('The saved workspace uses a custom harness path. Open that workspace directly with --workspace.')
  }
  return {
    entrypoint: relative(project.root, project.entrypoint).split(sep).join('/'),
    language: project.language,
    ...(workspace?.config.harness ? { harness: workspace.config.harness } : {}),
  }
}
