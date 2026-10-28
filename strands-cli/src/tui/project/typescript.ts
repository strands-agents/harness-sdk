import { register } from 'node:module'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL, URL } from 'node:url'
import { register as registerTypescript } from 'tsx/esm/api'
import type { Agent } from '@strands-agents/sdk'
import type { HarnessAgentOptions } from '@strands-agents/harness'

import type { ImportedAgentProject } from './import.js'
import { initializeAgentDefinition } from '../session/agent-definition.js'
import { prepareArchiveDependencies } from './archive.js'

export type AgentFactory = (options: HarnessAgentOptions) => Promise<Agent>

const registeredProjects = new Set<string>()
let typescriptRegistered = false

export async function loadTypescriptProject(
  project: ImportedAgentProject,
  configureEnvironment?: () => void
): Promise<{
  options: HarnessAgentOptions
  createAgent: AgentFactory
}> {
  await prepareArchiveDependencies(project.root, project.language)
  configureEnvironment?.()
  const root = realpathSync(project.root)
  const sourcePath = realpathSync(project.entrypoint)
  if (!typescriptRegistered) {
    registerTypescript()
    typescriptRegistered = true
  }
  if (!registeredProjects.has(sourcePath)) {
    const loader = new URL(
      import.meta.url.endsWith('.ts') ? './module-loader.ts' : './module-loader.js',
      import.meta.url
    )
    loader.searchParams.set('project', root)
    register(loader, {
      data: {
        runtimeParent: import.meta.url,
        projectRoot: pathToFileURL(`${root}/`).href,
        runtimeSdkRoot: new URL('.', import.meta.resolve('@strands-agents/sdk')).href,
        entrypoint: pathToFileURL(sourcePath).href,
      },
    })
    registeredProjects.add(sourcePath)
  }
  const loadDefinition = (): Promise<SourceConstruction & { evaluation: Promise<Record<string, unknown>> }> => {
    const entrypoint = pathToFileURL(sourcePath)
    entrypoint.searchParams.set('load', randomUUID())
    return new Promise((resolve, reject) => {
      const evaluation: Promise<Record<string, unknown>> = sourceConstruction.run(
        (construction) => {
          try {
            resolve({ ...construction, options: projectOptions(construction.options, root), evaluation })
          } catch (error) {
            construction.reject(error)
            reject(error)
          }
        },
        () => import(entrypoint.href)
      )
      void evaluation.then(() => reject(new Error('Agent source did not reach the harness constructor hook.')), reject)
    })
  }
  const initial = await loadDefinition()
  let used = false
  return {
    options: initial.options,
    createAgent: async (options): Promise<Agent> => {
      const definition = used ? await loadDefinition() : initial
      used = true
      const overrides: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(options)) {
        const previous: unknown = initial.options[key as keyof HarnessAgentOptions]
        if (value === previous) continue
        const replacement: unknown = definition.options[key as keyof HarnessAgentOptions]
        overrides[key] =
          Array.isArray(value) && Array.isArray(previous) && Array.isArray(replacement)
            ? value.map((item) => {
                const index = previous.indexOf(item)
                return index < 0 ? item : replacement[index]
              })
            : value
      }
      try {
        const built = await definition.factory({ ...definition.options, ...overrides })
        definition.resume(built)
        const namespace = await definition.evaluation
        const agent = (await namespace.__strandsAgent) as Agent
        if (!agent || typeof agent.initialize !== 'function') {
          throw new Error('createHarness() must return a Strands Agent.')
        }
        await initializeAgentDefinition(agent)
        return agent
      } catch (error) {
        definition.reject(error)
        await definition.evaluation.catch(() => undefined)
        throw error
      }
    },
  }
}

/** @internal */
export function projectOptions(input: HarnessAgentOptions, root: string): HarnessAgentOptions {
  const path = (value: string): string =>
    value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(root, value)
  const options = { ...input }
  if (typeof options.skills === 'string') {
    options.skills = options.skills.startsWith('https://') ? options.skills : path(options.skills)
  } else if (Array.isArray(options.skills)) {
    options.skills = options.skills.map((skill) =>
      typeof skill === 'string' && !skill.startsWith('https://') ? path(skill) : skill
    )
  }
  const policy = (value: unknown): unknown =>
    typeof value === 'string' && value.trim().endsWith('.cedar') ? path(value.trim()) : value
  if (options.interventions !== undefined) {
    options.interventions = (
      Array.isArray(options.interventions) ? options.interventions.map(policy) : policy(options.interventions)
    ) as Exclude<HarnessAgentOptions['interventions'], undefined>
  }
  if (options.mcpServers) {
    const document =
      typeof options.mcpServers === 'string'
        ? JSON.parse(readFileSync(path(options.mcpServers), 'utf8'))
        : options.mcpServers
    const servers = document.mcpServers ?? document
    options.mcpServers = Object.fromEntries(
      Object.entries(servers as Exclude<HarnessAgentOptions['mcpServers'], string | undefined>).map(
        ([name, server]) => [
          name,
          server.command
            ? {
                ...server,
                cwd: server.cwd
                  ? path(
                      server.cwd.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/gu, (_match, name: string) => {
                        const value = process.env[name]
                        if (value === undefined) throw new Error(`Environment variable "${name}" is not set.`)
                        return value
                      })
                    )
                  : root,
              }
            : server,
        ]
      )
    )
  }
  return options
}

interface SourceConstruction {
  options: HarnessAgentOptions
  factory: AgentFactory
  resume: (agent: Agent) => void
  reject: (error: unknown) => void
}

const sourceConstruction = new AsyncLocalStorage<(construction: SourceConstruction) => void>()

export function constructProjectAgent(factory: AgentFactory, options: HarnessAgentOptions): Promise<Agent> {
  const capture = sourceConstruction.getStore()
  if (!capture) throw new Error('Agent source must be loaded through the harness.')
  return new Promise((resume, reject) => capture({ options, factory, resume, reject }))
}
