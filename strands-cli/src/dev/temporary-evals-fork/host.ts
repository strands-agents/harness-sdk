import { resolve } from 'node:path'

import type { DevChatCommandContext } from '../../ui/chat/types.js'
import type { DevWorkspace } from '../workspace.js'
import type { TemporaryAgentFacts } from './agent-context.js'
import type { TemporaryUiDependencies } from './evals-ui.js'
import type { TemporaryExperimentDependencies } from './experiment.js'
import type { TemporaryOptimizationDependencies } from './optimize.js'
import type { TemporaryTestDependencies } from './test.js'

export type TemporarySessionDependencies = TemporaryExperimentDependencies &
  TemporaryTestDependencies &
  TemporaryOptimizationDependencies & {
    readonly initialCopy?: (workspace: DevWorkspace, signal: AbortSignal) => Promise<unknown>
  }

export interface TemporarySessionHost {
  readonly workspace: DevWorkspace
  readonly agent: () => TemporaryAgentFacts
  /** Seeds this session's autofill toggle from the saved setting. */
  readonly autofill?: () => boolean
  /** Whether a finished optimization's edits are written without a review. Read when a run ends, so a change counts. */
  readonly autoOptimize?: () => boolean
  readonly context?: DevChatCommandContext
  readonly dependencies?: TemporarySessionDependencies
  readonly evalsUi?: TemporaryUiDependencies
}

export type TemporaryHost = () => TemporarySessionHost

export const announce = (host: TemporarySessionHost, status: 'success' | 'error', text: string): void => {
  host.context?.report(status, text)
}

// Generated files are shown with their absolute path, so the developer and the model can open them from anywhere.
export const absolutePath = (path: string): string => resolve(path)

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`
