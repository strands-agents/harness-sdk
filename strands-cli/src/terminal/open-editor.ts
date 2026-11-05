import { createRequire } from 'node:module'

import type { ChatConfigurationProject } from '../agent/types.js'
import { splitArguments } from './arguments.js'
import { systemOpenCommand, type SystemOpenCommand } from './open-url.js'

const spawn = createRequire(import.meta.url)('cross-spawn') as typeof import('node:child_process').spawn

export function agentProjectEditorCommand(
  project: ChatConfigurationProject,
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): SystemOpenCommand & { interactive?: boolean } {
  const configured = environment.STRANDS_EDITOR ?? environment.VISUAL ?? environment.EDITOR
  if (configured?.trim()) {
    const [command, ...args] = splitArguments(configured)
    if (command) {
      return { command, args: [...args, project.root], interactive: true }
    }
  }
  return systemOpenCommand(platform, project.entrypoint)
}

export function openAgentProject(project: ChatConfigurationProject): Promise<void> {
  return new Promise((resolve, reject) => {
    const { command, args, env, interactive = false } = agentProjectEditorCommand(project)
    const child = spawn(command, args, {
      detached: !interactive,
      stdio: interactive ? 'inherit' : 'ignore',
      windowsHide: !interactive,
      env: env ? { ...process.env, ...env } : process.env,
    })
    child.once('error', reject)
    if (interactive) {
      child.once('close', (code, signal) => {
        if (code === 0) resolve()
        else reject(new Error(`Editor exited with ${signal ?? `status ${code}`}.`))
      })
      return
    }
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
