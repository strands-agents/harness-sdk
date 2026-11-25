import type { ChatToolInfo } from '../../agent/types.js'
import type { DevChatCommandContext } from '../../ui/chat/types.js'
import type { EvalsBrowserPlace } from '../panels/model.js'
import type { DevWorkspace } from '../workspace.js'
import type { TemporaryUiDependencies } from './evals-ui.js'
import type { TemporaryExperimentDependencies } from './experiment.js'
import type { TemporaryOptimizationDependencies } from './optimize.js'
import type { TemporaryTestDependencies } from './test.js'

export interface TemporaryAgentFacts {
  description?: string
  model?: string
  sessionId?: string
  sessionDirectory?: string
  tools?: readonly ChatToolInfo[]
}

export type TemporarySessionDependencies = TemporaryExperimentDependencies &
  TemporaryTestDependencies &
  TemporaryOptimizationDependencies & {}

/** The settings of the workspace that the dev sessions go by. They are read when needed, so a change counts at once. */
export interface TemporaryDevSettings {
  /** A finished optimization's edits are written without a review. */
  readonly autoAcceptOptimizationResults?: boolean
  /** An optimization starts by itself every this many chat turns; 0 starts none. */
  readonly autoOptimize?: number
}

export interface TemporarySessionHost {
  readonly workspace: DevWorkspace
  readonly agent: () => TemporaryAgentFacts
  readonly settings?: () => TemporaryDevSettings
  readonly context?: DevChatCommandContext
  readonly dependencies?: TemporarySessionDependencies
  readonly evalsUi?: TemporaryUiDependencies
  /** The evals UI address of a place, once the UI is ready. */
  readonly evalsLink?: (place: EvalsBrowserPlace, runFolder?: string) => string | undefined
}

export type TemporaryHost = () => TemporarySessionHost

export const announce = (host: TemporarySessionHost, status: 'success' | 'error', text: string): void => {
  host.context?.report(status, text)
}

export const evalsLinkText = (host: TemporarySessionHost, place: EvalsBrowserPlace, runFolder?: string): string => {
  const link = host.evalsLink?.(place, runFolder)
  return link ? `\nevals UI: ${link}` : ''
}

export const firstLine = (text: string): string =>
  text
    .split('\n')
    .find((line) => line.trim())
    ?.trim() ?? text

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`

const FILE_TOOLS: ReadonlySet<string> = new Set(['shell', 'write', 'edit'])
const listed = new Intl.ListFormat('en', { type: 'conjunction' })

export const temporaryFileChangeWarning = ({ workspace, agent }: TemporarySessionHost): string | undefined => {
  const tools = [...new Set((agent().tools ?? []).map(({ name }) => name).filter((name) => FILE_TOOLS.has(name)))]
  if (tools.length === 0) return undefined
  return (
    `Evaluations and optimizations run this agent in ${workspace.root}, and its ${listed.format(tools)} ` +
    `${tools.length === 1 ? 'tool' : 'tools'} can change files there.`
  )
}
