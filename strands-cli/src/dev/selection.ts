import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { CliConfigSnapshot } from '../config/store.js'
import { expandHome } from '../paths.js'
import { importAgentProject } from '../project/import.js'
import type { DiscoveredHarness } from './search.js'
import { readDevWorkspace } from './workspace.js'

export interface BaseHarnessSelection {
  name: string
  source: string
  workspace: string
  excludedEntrypoints: readonly string[]
}

export const baseHarnessSelection = async (
  snapshot: CliConfigSnapshot,
  cwd: string,
  destination?: string
): Promise<BaseHarnessSelection> => {
  const source = snapshot.agentProject
    ? importAgentProject(resolve(cwd, expandHome(snapshot.agentProject))).entrypoint
    : snapshot.path
  const workspace = resolve(cwd, destination ?? 'strands-dev')
  const existing =
    (await readDevWorkspace(workspace)) ??
    (!destination ? await readDevWorkspace(join(workspace, 'base-cli')) : undefined)
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
