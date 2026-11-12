import { dirname, relative } from 'node:path'

import type { DevChatCommandContext } from '../../ui/chat/types.js'
import type { DevWorkspace } from '../workspace.js'
import type { TemporaryAgentFacts } from './agent-context.js'
import { temporaryWorkspaceDirectory } from './evals-process.js'
import type { TemporaryExperimentDependencies } from './experiment.js'
import type { TemporaryOptimizationDependencies } from './optimize.js'
import type { TemporaryTestDependencies } from './test.js'

export type TemporarySessionDependencies = TemporaryExperimentDependencies &
  TemporaryTestDependencies &
  TemporaryOptimizationDependencies

export interface TemporarySessionHost {
  readonly workspace: DevWorkspace
  readonly agent: () => TemporaryAgentFacts
  readonly context?: DevChatCommandContext
  readonly dependencies?: TemporarySessionDependencies
}

export type TemporaryHost = () => TemporarySessionHost

export const announce = (host: TemporarySessionHost, status: 'success' | 'error', text: string): void => {
  host.context?.report(status, text)
}

export const shownPath = (workspace: DevWorkspace, path: string): string =>
  relative(dirname(temporaryWorkspaceDirectory(workspace)), path)

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`
