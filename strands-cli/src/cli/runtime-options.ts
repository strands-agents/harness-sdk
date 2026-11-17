import {
  createHarness,
  harnessAgentOptionsFromConfig,
  type HarnessAgentConfig,
  type HarnessAgentOptions,
} from '@strands-agents/harness'
import { InvokeModelStage, TextBlock, type Agent } from '@strands-agents/sdk'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { expandHome, strandsUserPath } from '../paths.js'
import type { AgentFactory } from '../project/typescript.js'
import { isRecord } from '../values.js'

export interface RuntimeOverrides {
  appendInstructions?: string
  stateDir?: string
}

export function workspaceStateDirectory(workspace: string, root = strandsUserPath('state', 'workspaces')): string {
  const key = createHash('sha256').update(realpathSync(workspace)).digest('hex').slice(0, 16)
  return join(resolve(expandHome(root)), key)
}

export async function profileOptions(
  profile: HarnessAgentConfig,
  baseDir: string,
  workspace: string
): Promise<HarnessAgentOptions> {
  const configured = { ...profile }
  const directory = workspaceStateDirectory(workspace)
  for (const key of ['session', 'memory'] as const) {
    const value = profile[key]
    if (value === false) continue
    if (value === true || value.dir === undefined) {
      Object.assign(configured, {
        [key]: { ...(value === true ? {} : value), dir: join(directory, key === 'session' ? 'sessions' : 'memory') },
      })
    }
  }
  return harnessAgentOptionsFromConfig(configured, baseDir)
}

export function runtimeOptions(
  options: HarnessAgentOptions,
  workspace: string,
  overrides: RuntimeOverrides = {},
  previousWorkspace = workspace
): HarnessAgentOptions {
  const directory = workspaceStateDirectory(workspace, overrides.stateDir)
  const previousDirectory = workspaceStateDirectory(previousWorkspace, overrides.stateDir)
  const result = { ...options }
  for (const key of ['session', 'memory'] as const) {
    const value = options[key]
    const manager = key === 'session' ? options.sessionManager : options.memoryManager
    const plain = isRecord(value) && Object.getPrototypeOf(value) === Object.prototype
    const custom =
      manager !== undefined ||
      (value !== undefined && value !== null && typeof value !== 'boolean' && !plain) ||
      (key === 'memory' &&
        plain &&
        value.stores !== undefined &&
        !(Array.isArray(value.stores) && value.stores.length === 0))
    if (custom) {
      if (overrides.stateDir !== undefined) {
        throw new Error(`--state-dir cannot relocate a custom ${key} store. Configure a built-in file store instead.`)
      }
      continue
    }
    if (value === false || value === null) continue
    if (key === 'session' && overrides.stateDir !== undefined && options.storage !== undefined) {
      throw new Error('--state-dir cannot relocate custom agent storage. Configure a built-in file store instead.')
    }
    const configured = plain ? value : {}
    if (
      overrides.stateDir !== undefined ||
      configured.dir === undefined ||
      configured.dir === join(previousDirectory, key === 'session' ? 'sessions' : 'memory')
    ) {
      Object.assign(result, {
        [key]: { ...configured, dir: join(directory, key === 'session' ? 'sessions' : 'memory') },
      })
    }
  }
  return result
}

export function runtimeAgentFactory(overrides: RuntimeOverrides, factory?: AgentFactory): AgentFactory {
  const configured = new WeakSet<Agent>()
  return async (options, prepare): Promise<Agent> => {
    const agent = factory ? await factory(options, prepare) : await createHarness(prepare ? prepare(options) : options)
    const text = overrides.appendInstructions
    if (text && !configured.has(agent)) {
      configured.add(agent)
      agent.addMiddleware(InvokeModelStage.Input, async (context) => ({
        ...context,
        systemPrompt: Array.isArray(context.systemPrompt)
          ? [...context.systemPrompt, new TextBlock(text)]
          : [context.systemPrompt, text].filter(Boolean).join('\n\n'),
      }))
    }
    return agent
  }
}
