import { spawn } from 'node:child_process'

import type { ChatConfigurationProject } from '../chat/types.js'
import { splitArguments } from '../terminal/arguments.js'
import { systemOpenCommand, type SystemOpenCommand } from '../terminal/open-url.js'

export function agentProjectEditorCommand(
  project: ChatConfigurationProject,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): SystemOpenCommand {
  const configured = environment.STRANDS_EDITOR ?? environment.VISUAL ?? environment.EDITOR
  if (configured?.trim()) {
    const [command, ...args] = splitArguments(configured)
    if (command) {
      return { command, args: [...args, project.root] }
    }
  }
  return systemOpenCommand(platform, project.entrypoint)
}

export function openAgentProject(project: ChatConfigurationProject): Promise<void> {
  return new Promise((resolve, reject) => {
    const { command, args } = agentProjectEditorCommand(project)
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
