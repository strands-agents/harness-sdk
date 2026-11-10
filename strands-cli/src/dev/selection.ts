import { realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import type { CliConfigSnapshot } from '../config/store.js'
import { expandHome } from '../paths.js'
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
  /\.zip$/iu.test(source) ? dirname(resolve(expandHome(source))) : project.root

export const baseHarnessSelection = async (
  snapshot: CliConfigSnapshot,
  cwd: string,
  destination?: string
): Promise<BaseHarnessSelection> => {
  const project = baseHarnessProject(snapshot, cwd)
  const source = project?.entrypoint ?? snapshot.path
  const launchWorkspace = resolve(cwd, destination ?? WORKSPACE_FOLDER)
  const legacy = destination ? undefined : await readDevWorkspace(join(launchWorkspace, 'base-cli'))
  const workspace =
    destination || legacy || !project
      ? launchWorkspace
      : join(harnessFolder(resolve(cwd, expandHome(snapshot.agentProject!)), project), WORKSPACE_FOLDER)
  const existing = (await readDevWorkspace(workspace)) ?? legacy
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

export const discoverLocalHarnesses = async (
  cwd: string,
  searchRoots: readonly string[],
  excludedEntrypoints: readonly string[]
): Promise<DiscoveredHarness[]> => {
  const discovery = await discoverHarnesses([cwd, ...searchRoots.map((path) => resolve(cwd, expandHome(path)))])
  const harnesses = await distinctHarnesses(discovery.harnesses, excludedEntrypoints)
  return Promise.all(harnesses.map(withPreparationStatus))
}
