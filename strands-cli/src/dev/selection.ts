import { realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { CliConfigSnapshot } from '../config/store.js'
import { expandHome, strandsUserPath } from '../paths.js'
import { importAgentProject, type ImportedAgentProject } from '../project/import.js'
import { planProjectPreparation } from '../project/preparation-plan.js'
import { discoverHarnesses, type DiscoveredHarness } from './search.js'
import { readDevWorkspace, WORKSPACE_FOLDER } from './workspace.js'

export interface BaseHarnessSelection {
  name: string
  source: string
  workspace: string
  excludedEntrypoints: readonly string[]
}

export const baseHarnessProject = (snapshot: CliConfigSnapshot, cwd: string): ImportedAgentProject | undefined =>
  snapshot.agentProject ? importAgentProject(resolve(cwd, expandHome(snapshot.agentProject))) : undefined

export const harnessFolder = (source: string, project: ImportedAgentProject): string =>
  dirname(/\.zip$/iu.test(source) ? resolve(expandHome(source)) : project.entrypoint)

export const baseHarnessSelection = async (
  snapshot: CliConfigSnapshot,
  cwd: string,
  destination?: string
): Promise<BaseHarnessSelection> => {
  const project = baseHarnessProject(snapshot, cwd)
  const source = project?.entrypoint ?? snapshot.path
  const workspace = destination ? resolve(cwd, destination) : strandsUserPath(WORKSPACE_FOLDER)
  const existing = await readDevWorkspace(workspace)
  return {
    name: existing?.config.name ?? snapshot.profile.name,
    source,
    workspace,
    excludedEntrypoints: [...(snapshot.agentProject ? [source] : []), ...(existing ? [existing.entrypoint] : [])],
  }
}

const canonicalPath = async (path: string): Promise<string> => {
  const absolute = resolve(expandHome(path))
  try {
    return await realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolute
    throw error
  }
}

export const distinctHarnesses = async (
  harnesses: readonly DiscoveredHarness[],
  excludedEntrypoints: readonly string[]
): Promise<DiscoveredHarness[]> => {
  const seen = new Set(await Promise.all(excludedEntrypoints.map(canonicalPath)))
  const result: DiscoveredHarness[] = []
  for (const harness of harnesses) {
    const path = await canonicalPath(harness.entrypoint)
    if (seen.has(path)) continue
    seen.add(path)
    result.push(harness)
  }
  return result
}

const withPreparationStatus = async (harness: DiscoveredHarness): Promise<DiscoveredHarness> => {
  try {
    const plan = await planProjectPreparation(harness)
    return { ...harness, preparationStatus: plan.manager === 'manual' ? 'Manual setup' : 'Needs setup' }
  } catch {
    return { ...harness, preparationStatus: 'Check setup' }
  }
}

export interface LocalHarnessSearch {
  signal?: AbortSignal
  found?(harness: DiscoveredHarness): void | Promise<void>
}

const byEntrypoint = (left: DiscoveredHarness, right: DiscoveredHarness): number =>
  left.entrypoint < right.entrypoint ? -1 : left.entrypoint > right.entrypoint ? 1 : 0

export const discoverLocalHarnesses = async (
  cwd: string,
  searchRoots: readonly string[],
  excludedEntrypoints: readonly string[],
  search: LocalHarnessSearch = {}
): Promise<DiscoveredHarness[]> => {
  const excluded = new Set(await Promise.all(excludedEntrypoints.map(canonicalPath)))
  const kept = new Map<string, DiscoveredHarness>()
  let reported = Promise.resolve()
  const report = (harness: DiscoveredHarness): void => {
    reported = reported.then(async () => {
      const path = await canonicalPath(harness.entrypoint)
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
  return [...kept.values()].sort(byEntrypoint)
}
