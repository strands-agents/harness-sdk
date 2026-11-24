import { resolve } from 'node:path'

import type { DevChatCommandContext } from '../../ui/chat/types.js'
import type { DevWorkspace } from '../workspace.js'
import type { TemporaryAgentFacts } from './agent-context.js'
import type { TemporaryExperimentDependencies } from './experiment.js'
import type { TemporaryOptimizationDependencies } from './optimize.js'
import type { TemporaryTestDependencies } from './test.js'

export type TemporarySessionDependencies = TemporaryExperimentDependencies &
  TemporaryTestDependencies &
  TemporaryOptimizationDependencies & {
    readonly initialCopy?: (workspace: DevWorkspace, signal: AbortSignal) => Promise<unknown>
  }

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
}

export type TemporaryHost = () => TemporarySessionHost

export const announce = (host: TemporarySessionHost, status: 'success' | 'error', text: string): void => {
  host.context?.report(status, text)
}

// Generated files are shown with their absolute path, so the developer and the model can open them from anywhere.
export const absolutePath = (path: string): string => resolve(path)

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`
