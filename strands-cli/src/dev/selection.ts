import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { CliConfigSnapshot } from '../config/store.js'
import { expandHome, strandsUserPath } from '../paths.js'
import { importAgentProject, type ImportedAgentProject } from '../project/import.js'
import { planProjectPreparation } from '../project/preparation-plan.js'
import { discoverHarnesses, type DiscoveredHarness } from './search.js'
import { missingAgentPath, readDevWorkspace, WORKSPACE_FOLDER, type DevWorkspace } from './workspace.js'

export interface BaseHarnessSelection {
  name: string
  source: string
  workspace: string
  excludedEntrypoints: readonly string[]
  holds(workspace: DevWorkspace): boolean
}

export const harnessFolder = (source: string, project: ImportedAgentProject): string =>
  dirname(/\.zip$/iu.test(source) ? resolve(expandHome(source)) : project.entrypoint)

export const baseHarnessSelection = async (
  snapshot: CliConfigSnapshot,
  cwd: string,
  destination?: string
): Promise<BaseHarnessSelection> => {
  const project = snapshot.agentProject
    ? importAgentProject(resolve(cwd, expandHome(snapshot.agentProject)))
    : undefined
  const source = project?.entrypoint ?? snapshot.path
  const workspace = destination ? resolve(cwd, destination) : strandsUserPath(WORKSPACE_FOLDER)
  const sameFile = (left: string, right: string): boolean =>
    canonicalPath(resolve(cwd, expandHome(left))) === canonicalPath(resolve(cwd, expandHome(right)))
  const madeFromThisCli = ({ config, entrypoint }: DevWorkspace): boolean => {
    const { source: origin } = config.origin
    if (origin === undefined) return true
    if (!snapshot.agentProject) return sameFile(origin, snapshot.path)
    return sameFile(entrypoint, source) || sameFile(origin, snapshot.agentProject)
  }
  const holds = (bound: DevWorkspace): boolean => bound.config.origin.kind === 'cli' && madeFromThisCli(bound)
  const bound = await readDevWorkspace(workspace).catch(async (failure: unknown) => {
    if ((await missingAgentPath(workspace, failure)) === undefined) throw failure
    return undefined
  })
  const existing = bound && holds(bound) ? bound : undefined
  return {
    name: existing?.config.name ?? snapshot.profile.name,
    source,
    workspace,
    excludedEntrypoints: [...(snapshot.agentProject ? [source] : []), ...(existing ? [existing.entrypoint] : [])],
    holds,
  }
}

const canonicalPath = (path: string): string => {
  const absolute = resolve(expandHome(path))
  try {
    return realpathSync(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolute
    throw error
  }
}

const withPreparationStatus = async (harness: DiscoveredHarness): Promise<DiscoveredHarness> => {
  try {
    const plan = await planProjectPreparation(harness)
    return { ...harness, preparationStatus: plan.manager === 'manual' ? 'Manual setup' : 'Needs setup' }
  } catch {
    return { ...harness, preparationStatus: 'Check setup' }
  }
}

export interface LocalHarnessDiscovery {
  harnesses: DiscoveredHarness[]
}

const byEntrypoint = (left: DiscoveredHarness, right: DiscoveredHarness): number =>
  left.entrypoint < right.entrypoint ? -1 : left.entrypoint > right.entrypoint ? 1 : 0

export const discoverLocalHarnesses = async (
  cwd: string,
  searchRoots: readonly string[],
  excludedEntrypoints: readonly string[],
  search: { signal?: AbortSignal; found?(harness: DiscoveredHarness): void | Promise<void> } = {}
): Promise<LocalHarnessDiscovery> => {
  const excluded = new Set(excludedEntrypoints.map(canonicalPath))
  const kept = new Map<string, DiscoveredHarness>()
  let reported = Promise.resolve()
  const report = (harness: DiscoveredHarness): void => {
    reported = reported.then(async () => {
      const path = canonicalPath(harness.entrypoint)
      const previous = kept.get(path)
      if (excluded.has(path) || (previous && (previous.workspace || !harness.workspace))) return
      const prepared = await withPreparationStatus(harness)
      kept.set(path, prepared)
      await search.found?.(prepared)
    })
  }
  const discovery = await discoverHarnesses([cwd, ...searchRoots.map((path) => resolve(cwd, expandHome(path)))], {
    ...(search.signal ? { signal: search.signal } : {}),
    found: report,
  })
  discovery.harnesses.forEach(report)
  await reported
  return { harnesses: [...kept.values()].sort(byEntrypoint) }
}
