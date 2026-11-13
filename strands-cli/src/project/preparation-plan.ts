import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { satisfies } from 'semver'

import type { ImportedAgentProject } from './import.js'
import { isRecord } from '../values.js'

export type PreparationStage = 'runtime' | 'dependencies' | 'build' | 'entrypoint'
export interface PreparationCommand {
  stage: PreparationStage
  command: string
  args: string[]
}
export interface ProjectPreparationPlan {
  project: ImportedAgentProject
  runtime: string
  pythonRequirement?: string
  manager: 'npm' | 'pip' | 'uv' | 'manual'
  commands: PreparationCommand[]
  fingerprint: string
  guidance?: string
}

const INPUTS = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'pyproject.toml',
  'requirements.txt',
  'uv.lock',
  'poetry.lock',
  'Pipfile.lock',
  '.npmrc',
  '.python-version',
  'setup.py',
  'setup.cfg',
  'uv.toml',
]
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

const readInputs = async (root: string): Promise<Map<string, string>> => {
  const inputs = new Map<string, string>()
  for (const name of INPUTS) {
    const path = join(root, name)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANIFEST_BYTES)
        throw new Error(`Project metadata must be a regular file below 4 MB: ${path}`)
      inputs.set(name, await readFile(path, 'utf8'))
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') continue
      throw error
    }
  }
  return inputs
}

const command = (stage: PreparationStage, executable: string, args: string[]): PreparationCommand => ({
  stage,
  command: executable,
  args,
})

const nodePlan = (
  project: ImportedAgentProject,
  inputs: Map<string, string>
): Omit<ProjectPreparationPlan, 'fingerprint'> => {
  const raw = inputs.get('package.json')
  if (!raw)
    return {
      project,
      runtime: `Node ${process.versions.node}`,
      manager: 'manual',
      commands: [],
      guidance: 'No package.json was found. Prepare this script’s dependencies manually, or select its project root.',
    }
  const manifest: unknown = JSON.parse(raw)
  if (!isRecord(manifest)) throw new Error(`Expected an object in ${join(project.root, 'package.json')}.`)
  const engine = isRecord(manifest.engines) ? manifest.engines.node : undefined
  if (typeof engine === 'string' && !satisfies(process.versions.node, engine, { includePrerelease: true })) {
    throw new Error(
      `Node ${process.versions.node} does not satisfy package.json engines.node (${engine}). Select a supported Node version and restart strands dev.`
    )
  }
  const unsupported = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].find((name) => inputs.has(name))
  if (
    unsupported ||
    (typeof manifest.packageManager === 'string' && !manifest.packageManager.startsWith('npm@')) ||
    manifest.workspaces
  ) {
    return {
      project,
      runtime: `Node ${process.versions.node}`,
      manager: 'manual',
      commands: [],
      guidance: `Prepare dependencies and build with this project's declared package manager${unsupported ? ` (${unsupported})` : ''}. Then choose Validate existing environment. Automatic setup currently supports standalone npm projects.`,
    }
  }
  const locked = inputs.has('package-lock.json') || inputs.has('npm-shrinkwrap.json')
  const commands = [
    command('dependencies', 'npm', [
      locked ? 'ci' : 'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--global=false',
      ...(locked ? [] : ['--package-lock=false', '--no-save']),
    ]),
  ]
  if (isRecord(manifest.scripts) && typeof manifest.scripts.build === 'string')
    commands.push(command('build', 'npm', ['--global=false', 'run', 'build']))
  return { project, runtime: `Node ${process.versions.node}`, manager: 'npm', commands }
}

const pythonPlan = (
  project: ImportedAgentProject,
  inputs: Map<string, string>
): Omit<ProjectPreparationPlan, 'fingerprint'> => {
  const python = join(project.root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const raw = inputs.get('pyproject.toml')
  const manifest = raw ? parseToml(raw) : {}
  const projectConfig = isRecord(manifest.project) ? manifest.project : undefined
  const version = projectConfig?.['requires-python']
  const runtime = `Python${typeof version === 'string' ? ` ${version}` : ' >=3.10'} · ${python}`
  const foreignLock = ['poetry.lock', 'Pipfile.lock'].find((name) => inputs.has(name))
  const tool = isRecord(manifest.tool) ? manifest.tool : {}
  if (foreignLock || (tool.poetry && !inputs.has('uv.lock')))
    return {
      project,
      runtime,
      manager: 'manual',
      commands: [],
      guidance: `Prepare this project with its declared Python package manager${foreignLock ? ` (${foreignLock})` : ''}. Use its project .venv, then choose Validate existing environment.`,
    }
  if (inputs.has('uv.lock')) {
    if (!raw || !projectConfig)
      throw new Error('uv.lock requires pyproject.toml with [project]. Select the project root that owns both files.')
    return {
      project,
      runtime,
      manager: 'uv',
      commands: [command('dependencies', 'uv', ['sync', '--locked', '--inexact'])],
    }
  }
  const commands: PreparationCommand[] = [command('runtime', python, ['Prepare a local Python runtime'])]
  const requirements = inputs.has('requirements.txt')
  if (requirements)
    commands.push(
      command('dependencies', python, [
        '-I',
        '-m',
        'pip',
        'install',
        '--disable-pip-version-check',
        '-r',
        'requirements.txt',
      ])
    )
  const installable = isRecord(manifest['build-system'])
  if (installable) {
    commands.push(
      command('dependencies', python, ['-I', '-m', 'pip', 'install', '--disable-pip-version-check', '--editable', '.'])
    )
  } else if (projectConfig && Array.isArray(projectConfig.dependencies) && !requirements) {
    const dependencies = projectConfig.dependencies
    if (dependencies.some((value) => typeof value !== 'string' || !value.trim() || value.startsWith('-')))
      throw new Error('pyproject.toml project.dependencies must contain package requirements, not command options.')
    if (dependencies.length)
      commands.push(
        command('dependencies', python, [
          '-I',
          '-m',
          'pip',
          'install',
          '--disable-pip-version-check',
          ...(dependencies as string[]),
        ])
      )
  }
  const guidance =
    !installable && !requirements && !projectConfig
      ? 'No installable Python project or requirements.txt was found. The harness runtime can be prepared, but other imports must already be available. For src-layout packages, add package metadata with a build backend.'
      : !installable && projectConfig
        ? 'This pyproject.toml has no build-system, so the local package will not be installed. If imports refer to a package under src/, configure a build backend or prepare it manually.'
        : undefined
  return {
    project,
    runtime,
    manager: 'pip',
    commands,
    ...(typeof version === 'string' ? { pythonRequirement: version } : {}),
    ...(guidance ? { guidance } : {}),
  }
}

export const planProjectPreparation = async (project: ImportedAgentProject): Promise<ProjectPreparationPlan> => {
  const inputs = await readInputs(project.root)
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([...inputs]))
    .digest('hex')
  let plan = project.language === 'python' ? pythonPlan(project, inputs) : nodePlan(project, inputs)
  if (plan.manager === 'npm') {
    for (let parent = dirname(project.root); dirname(parent) !== parent; parent = dirname(parent)) {
      try {
        const value: unknown = JSON.parse(await readFile(join(parent, 'package.json'), 'utf8'))
        if (isRecord(value) && value.workspaces) {
          plan = {
            ...plan,
            manager: 'manual',
            commands: [],
            guidance: `This package belongs to a Node workspace at ${parent}. Run its declared package-manager install and build there, then validate this entrypoint.`,
          }
          break
        }
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error
      }
    }
  }
  return { ...plan, fingerprint }
}

export const describePreparationCommand = ({ stage, command: executable, args }: PreparationCommand): string =>
  stage === 'runtime' && args[0] === 'Prepare a local Python runtime'
    ? `Prepare project .venv and the Strands harness runtime (Python 3.10 or newer)`
    : [executable, ...args].map((value) => (/[\s"']/u.test(value) ? JSON.stringify(value) : value)).join(' ')
