import type { HarnessAgentOptions, MemoryConfig, SessionConfig } from '@strands-agents/harness'
import { MemoryManager, SessionManager } from '@strands-agents/sdk'
import { join } from 'node:path'

export type DevStateManager = 'session' | 'memory' | 'storage'

interface IsolatedOption<Config> {
  readonly option: Config | false
  readonly custom: boolean
}

const STATE_MANAGER_OPTIONS = ['sessionManager', 'memoryManager', 'storage'] as const

const DEV_STATE_LABELS: Record<DevStateManager, string> = {
  session: 'session manager',
  memory: 'memory',
  storage: 'storage',
}

export const devSessionsFolder = (root: string): string => join(root, '.strands/state/sessions')

const devMemoryFolder = (root: string): string => join(root, '.strands/state/memory')

const isolateSession = (
  { session, sessionManager }: HarnessAgentOptions,
  root: string
): IsolatedOption<SessionConfig> => {
  if (sessionManager !== undefined || session instanceof SessionManager) return { option: false, custom: true }
  if (session === false || session === null) return { option: false, custom: false }
  return { option: { ...(typeof session === 'object' ? session : {}), dir: devSessionsFolder(root) }, custom: false }
}

const isolateMemory = ({ memory, memoryManager }: HarnessAgentOptions, root: string): IsolatedOption<MemoryConfig> => {
  if (memoryManager !== undefined || memory instanceof MemoryManager) return { option: false, custom: true }
  if (memory === false || memory === null) return { option: false, custom: false }
  if (typeof memory === 'object' && (memory.stores?.length ?? 0) > 0) return { option: false, custom: true }
  return { option: { ...(typeof memory === 'object' ? memory : {}), dir: devMemoryFolder(root) }, custom: false }
}

export const isolateDevState = (
  options: HarnessAgentOptions,
  root: string
): { options: HarnessAgentOptions; turnedOff: DevStateManager[] } => {
  const session = isolateSession(options, root)
  const memory = isolateMemory(options, root)
  const turnedOff: DevStateManager[] = [
    ...(session.custom ? (['session'] as const) : []),
    ...(memory.custom ? (['memory'] as const) : []),
    ...(options.storage !== undefined ? (['storage'] as const) : []),
  ]
  const isolated: HarnessAgentOptions = { ...options, session: session.option, memory: memory.option }
  for (const option of STATE_MANAGER_OPTIONS) {
    if (options[option] !== undefined) Reflect.set(isolated, option, undefined)
  }
  return { options: isolated, turnedOff }
}

export const devStateNotice = (turnedOff: readonly DevStateManager[]): string | undefined => {
  if (turnedOff.length === 0) return undefined
  const managers = new Intl.ListFormat('en', { type: 'conjunction' }).format(
    turnedOff.map((manager) => DEV_STATE_LABELS[manager])
  )
  const notice = `Dev deactivated the custom ${managers} of this agent in this chat. Thus the chat cannot write into the stores of the agent.`
  return turnedOff.includes('session') ? `${notice} Dev does not save this chat.` : notice
}

/**
 * Set for a strands dev that another strands dev starts on the project it has open. The project is prepared then,
 * so the one that is started does not install or build it again.
 */
export const DEV_PROJECT_PREPARED = 'STRANDS_DEV_PROJECT_PREPARED'

export const projectPreparedByParent = (environment: NodeJS.ProcessEnv = process.env): boolean =>
  environment[DEV_PROJECT_PREPARED] === '1'
