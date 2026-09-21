import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import type { Agent } from '@strands-agents/sdk'
import type { HarnessAgentOptions } from '@strands-agents/harness'

import { sessionSettings } from './options.js'
import { DEFAULT_SESSION_DIR } from './sessions.js'

export const AGENT_DEFINITION_META_KEY = 'strands/agent-definition'

interface SessionAgentDefinition {
  version: 1
  name?: string
  description?: string
  instructions?: string
}

export function sessionAgentDefinitionFromMeta(
  meta: Record<string, unknown> | null | undefined
): Pick<HarnessAgentOptions, 'name' | 'description' | 'instructions'> | undefined {
  const value = meta?.[AGENT_DEFINITION_META_KEY]
  if (value === undefined) {
    return undefined
  }
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    typeof value.description !== 'string' ||
    typeof value.instructions !== 'string'
  ) {
    throw new Error('Agent definition metadata is invalid.')
  }
  return {
    name: value.name,
    description: value.description,
    instructions: value.instructions,
  }
}

export async function restoreSessionAgentDefinition(
  options: HarnessAgentOptions,
  cwd = process.cwd()
): Promise<HarnessAgentOptions> {
  const session = sessionSettings(options.session)
  if (!session.id) {
    return options
  }
  const definition = await readSessionAgentDefinition(resolve(cwd, session.dir ?? DEFAULT_SESSION_DIR), session.id)
  return definition ? { ...definition, ...options } : options
}

export async function persistSessionAgentDefinition(options: HarnessAgentOptions, cwd = process.cwd()): Promise<void> {
  const session = sessionSettings(options.session)
  if (!session.id) {
    return
  }
  const definition: SessionAgentDefinition = {
    version: 1,
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
  }
  if (Object.keys(definition).length === 1) {
    return
  }
  const path = agentDefinitionPath(resolve(cwd, session.dir ?? DEFAULT_SESSION_DIR), session.id)
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, `${JSON.stringify(definition, null, 2)}\n`, {
      mode: 0o600,
    })
    await fs.rename(temporary, path)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function readSessionAgentDefinition(
  sessionDirectory: string,
  sessionId: string
): Promise<Omit<SessionAgentDefinition, 'version'> | undefined> {
  try {
    const document = JSON.parse(await fs.readFile(agentDefinitionPath(sessionDirectory, sessionId), 'utf8')) as unknown
    if (!isRecord(document) || document.version !== 1) {
      return undefined
    }
    const definition = {
      ...(typeof document.name === 'string' ? { name: document.name } : {}),
      ...(typeof document.description === 'string' ? { description: document.description } : {}),
      ...(typeof document.instructions === 'string' ? { instructions: document.instructions } : {}),
    }
    return Object.keys(definition).length > 0 ? definition : undefined
  } catch {
    return undefined
  }
}

function agentDefinitionPath(sessionDirectory: string, sessionId: string): string {
  const normalized =
    sessionId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-') || 'default'
  return join(sessionDirectory, normalized, 'agent.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export async function initializeAgentDefinition(agent: Agent): Promise<void> {
  const loadSnapshot = agent.loadSnapshot
  agent.loadSnapshot = (snapshot): void => {
    const data = { ...snapshot.data }
    delete data.systemPrompt
    loadSnapshot.call(agent, { ...snapshot, data })
  }
  try {
    await agent.initialize()
  } finally {
    agent.loadSnapshot = loadSnapshot
  }
}
