import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import type { ProjectPreparationPlan } from './preparation-plan.js'
import { isRecord } from '../values.js'

const IGNORED_INPUTS = new Set([
  '.git',
  '.strands',
  '.agent',
  '.venv',
  'node_modules',
  'dist',
  'build',
  '__pycache__',
  'tmp',
  '.config',
])
const MAX_INPUT_BYTES = 32 * 1024 * 1024
const MAX_INPUT_FILES = 10000
const SETUP_INPUTS = ['.npmrc', '.python-version', 'setup.py', 'setup.cfg', 'uv.toml']

export interface PreparationCacheState {
  dependencies: string | undefined
  build: string | undefined
  environmentReady: boolean
}

interface PreparedRecord {
  version: 1
  dependencies?: string
  build?: string
  environment: string
  log: string
}

const fileState = async (path: string): Promise<string> => {
  try {
    const stat = await lstat(path)
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.isSymbolicLink() ? await realpath(path) : ''}`
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return 'missing'
    throw error
  }
}

const sourceFingerprint = async (root: string, output = false): Promise<string | undefined> => {
  const hash = createHash('sha256')
  let bytes = 0
  let files = 0
  const visit = async (directory: string): Promise<boolean> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (!output && (IGNORED_INPUTS.has(entry.name) || entry.name.endsWith('.egg-info'))) continue
      const path = join(directory, entry.name)
      hash.update(relative(root, path)).update('\0')
      if (entry.isSymbolicLink()) hash.update(await readlink(path))
      else if (entry.isDirectory()) {
        if (!(await visit(path))) return false
      } else if (entry.isFile()) {
        const stat = await lstat(path)
        bytes += stat.size
        files++
        if (bytes > MAX_INPUT_BYTES || files > MAX_INPUT_FILES) return false
        hash.update(await readFile(path))
      }
    }
    return true
  }
  return (await visit(root)) ? hash.digest('hex') : undefined
}

const requirementsFingerprint = async (root: string): Promise<string | undefined> => {
  const hash = createHash('sha256')
  const visited = new Set<string>()
  let bytes = 0
  const visit = async (path: string): Promise<boolean> => {
    if (visited.has(path)) return true
    visited.add(path)
    if (visited.size > 256) return false
    let source: string
    try {
      const details = await lstat(path)
      if (!details.isFile() || details.isSymbolicLink() || (await realpath(path)) !== path) return false
      bytes += details.size
      if (bytes > MAX_INPUT_BYTES) return false
      source = await readFile(path, 'utf8')
    } catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') {
        hash.update(path).update('missing')
        return true
      }
      throw error
    }
    hash.update(path).update('\0').update(source).update('\0')
    for (const line of source.replace(/\\\r?\n/gu, '').split(/\r?\n/u)) {
      const include = /^\s*(?:-r\s*|-c\s*|--requirement(?:=|\s+)|--constraint(?:=|\s+))(.+?)\s*(?:\s+#.*)?$/u.exec(line)
      if (!include) continue
      const value = include[1]!.trim().replace(/^(?:"(.*)"|'(.*)')$/u, '$1$2')
      if (!value || value.includes('$') || /^[a-z][a-z0-9+.-]*:/iu.test(value)) return false
      if (!(await visit(resolve(dirname(path), value)))) return false
    }
    return true
  }
  return (await visit(join(root, 'requirements.txt'))) ? hash.digest('hex') : undefined
}

const environmentFingerprint = async (plan: ProjectPreparationPlan): Promise<{ value: string; ready: boolean }> => {
  const root = plan.project.root
  const paths =
    plan.project.language === 'typescript'
      ? [join(root, 'node_modules'), join(root, 'node_modules/.package-lock.json')]
      : [
          join(root, '.venv/pyvenv.cfg'),
          join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
        ]
  if (plan.project.language === 'typescript') {
    try {
      const manifest: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
      if (isRecord(manifest))
        for (const field of ['dependencies', 'devDependencies']) {
          const values = manifest[field]
          if (isRecord(values))
            for (const name of Object.keys(values)) paths.push(join(root, 'node_modules', name, 'package.json'))
        }
    } catch (error) {
      if (!isRecord(error) || error.code !== 'ENOENT') throw error
    }
  } else {
    for (const base of [join(root, '.venv/lib'), join(root, '.venv/Lib')]) {
      try {
        const entries = await readdir(base, { withFileTypes: true })
        const directories =
          process.platform === 'win32'
            ? [join(base, 'site-packages')]
            : entries
                .filter((entry) => entry.isDirectory() && entry.name.startsWith('python'))
                .map((entry) => join(base, entry.name, 'site-packages'))
        for (const directory of directories) {
          paths.push(directory)
          for (const name of (await readdir(directory)).filter(
            (value) => value.endsWith('.dist-info') || value.endsWith('.pth') || value.includes('strands')
          ))
            paths.push(join(directory, name))
        }
      } catch (error) {
        if (!isRecord(error) || error.code !== 'ENOENT') throw error
      }
    }
  }
  const states = await Promise.all(paths.map(fileState))
  const requiredStart = plan.project.language === 'typescript' ? 2 : 0
  const ready =
    plan.project.language === 'typescript'
      ? paths.length === 2 ||
        (states[0] !== 'missing' && states.slice(requiredStart).every((state) => state !== 'missing'))
      : states[0] !== 'missing' && states[1] !== 'missing' && paths.some((path) => path.includes('site-packages'))
  return { value: createHash('sha256').update(JSON.stringify(states)).digest('hex'), ready }
}

export const preparationCacheState = async (
  plan: ProjectPreparationPlan
): Promise<PreparationCacheState & { environment: string }> => {
  const environment = await environmentFingerprint(plan)
  const source = await sourceFingerprint(plan.project.root)
  const outputs = await Promise.all(
    ['dist', 'build'].map(async (name) => {
      const path = join(plan.project.root, name)
      const state = await fileState(path)
      if (state === 'missing') return { state, fingerprint: state }
      const details = await lstat(path)
      return {
        state,
        fingerprint: details.isSymbolicLink()
          ? undefined
          : details.isDirectory()
            ? await sourceFingerprint(path, true)
            : details.isFile() && details.size <= MAX_INPUT_BYTES
              ? createHash('sha256')
                  .update(await readFile(path))
                  .digest('hex')
              : undefined,
      }
    })
  )
  const setupInputs = await Promise.all(
    SETUP_INPUTS.map(async (name) => {
      const path = join(plan.project.root, name)
      const state = await fileState(path)
      if (state === 'missing') return [name, state]
      const details = await lstat(path)
      return [
        name,
        details.isFile() && !details.isSymbolicLink() && details.size <= MAX_INPUT_BYTES
          ? createHash('sha256')
              .update(await readFile(path))
              .digest('hex')
          : state,
      ]
    })
  )
  const requirements =
    plan.project.language === 'python' ? await requirementsFingerprint(plan.project.root) : 'not-python'
  const dependencies =
    requirements === undefined
      ? undefined
      : createHash('sha256')
          .update(
            JSON.stringify([
              plan.fingerprint,
              setupInputs,
              requirements,
              process.versions.node,
              process.platform,
              process.arch,
              plan.commands.filter((step) => step.stage !== 'build'),
            ])
          )
          .digest('hex')
  return {
    dependencies,
    environment: environment.value,
    environmentReady: environment.ready,
    build:
      source && outputs.every((output) => output.fingerprint !== undefined)
        ? createHash('sha256')
            .update(JSON.stringify([source, outputs, plan.commands.filter((step) => step.stage === 'build')]))
            .digest('hex')
        : undefined,
  }
}

export const cachedPreparation = async (
  path: string,
  state: PreparationCacheState & { environment: string }
): Promise<{ dependencies: boolean; build: boolean; log?: string }> => {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) return { dependencies: false, build: false }
    const value: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRecord(value) || value.version !== 1) return { dependencies: false, build: false }
    const dependencies =
      state.dependencies !== undefined &&
      state.environmentReady &&
      state.dependencies === value.dependencies &&
      state.environment === value.environment
    return {
      dependencies,
      build: dependencies && state.build !== undefined && state.build === value.build,
      ...(typeof value.log === 'string' ? { log: value.log } : {}),
    }
  } catch (error) {
    if (error instanceof SyntaxError || (isRecord(error) && error.code === 'ENOENT'))
      return { dependencies: false, build: false }
    throw error
  }
}

export const savePreparationCache = async (
  path: string,
  state: PreparationCacheState & { environment: string },
  log: string
): Promise<void> => {
  const record: PreparedRecord = {
    version: 1,
    ...(state.dependencies ? { dependencies: state.dependencies } : {}),
    environment: state.environment,
    log,
    ...(state.build ? { build: state.build } : {}),
  }
  const staging = join(dirname(path), `.prepared-${randomUUID()}.json`)
  try {
    await writeFile(staging, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
    await rename(staging, path)
  } finally {
    await rm(staging, { force: true })
  }
}
