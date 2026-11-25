import { mkdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import { bindWorkspace, boundDevWorkspace, type DevWorkspace } from './workspace.js'

export const initializeWorkspaceBinding = async (workspace: DevWorkspace, directory: string): Promise<DevWorkspace> => {
  const target = resolve(workspace.directory ?? directory)
  await mkdir(target, { recursive: true })
  return boundDevWorkspace(
    await bindWorkspace(target, {
      version: 1,
      name: workspace.config.name,
      agent: {
        path: workspace.root,
        entrypoint: relative(workspace.root, workspace.entrypoint).split(sep).join('/'),
        language: workspace.config.language,
      },
      origin: workspace.config.origin,
      ...(workspace.config.harness ? { harness: workspace.config.harness } : {}),
    })
  )
}
