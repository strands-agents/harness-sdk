import { createElement } from 'react'

import type { ImportedAgentProject } from '../../project/import.js'
import type { DevChatCommand, DevChatCommandContext, DevChatJob, DevChatPanelView } from '../../ui/chat/types.js'
import { ExperimentPanel } from '../panels/experiment.js'
import { OptimizePanel } from '../panels/optimize.js'
import { TestPanel } from '../panels/test.js'
import type { DevChatPart } from '../chat-extension.js'
import type { DevWorkspace } from '../workspace.js'
import type { TemporaryAgentFacts } from './agent-context.js'
import { temporaryDevChatPart as temporaryAgentTools } from './agent-tools.js'
import { readTemporaryEvaluators } from './evaluators.js'
import { temporaryGenerationJobs } from './experiments-session.js'
import { temporaryJobsFeed, type TemporaryStore } from './jobs.js'
import {
  temporaryDevSessions,
  temporaryOptimizeJobs,
  temporaryTestJobs,
  type TemporaryDevSessions,
} from './sessions.js'

interface PanelSession<State> extends TemporaryStore<State> {
  show(): void
}

interface PanelCommand<State> {
  readonly name: string
  readonly description: string
  readonly session: (sessions: TemporaryDevSessions) => PanelSession<State>
  readonly jobs: (state: State) => readonly DevChatJob[]
  readonly view: (sessions: TemporaryDevSessions) => DevChatPanelView
}

type Sessions = (context?: DevChatCommandContext) => TemporaryDevSessions

const devCommand = <State>(
  { name, description, session, jobs, view }: PanelCommand<State>,
  sessions: Sessions
): DevChatCommand => ({
  spec: { name, usage: `/${name}`, description },
  open: (context): DevChatPanelView => {
    const opened = sessions(context)
    session(opened).show()
    return view(opened)
  },
  attach: (context): void => void sessions(context),
  jobs: temporaryJobsFeed(session(sessions()), jobs),
})

const PANEL_COMMANDS: readonly ((sessions: Sessions) => DevChatCommand)[] = [
  (sessions): DevChatCommand =>
    devCommand(
      {
        name: 'experiment',
        description: 'TEMPORARY: generate test cases for this agent with strands-evals, and review them',
        session: ({ experiments }) => ({
          subscribe: experiments.subscribe,
          snapshot: experiments.snapshot,
          show: () => experiments.refresh(),
        }),
        jobs: temporaryGenerationJobs,
        view:
          ({ experiments }) =>
          (props) =>
            createElement(ExperimentPanel, { ...props, session: experiments }),
      },
      sessions
    ),
  (sessions): DevChatCommand =>
    devCommand(
      {
        name: 'test',
        description: 'TEMPORARY: run this agent on an experiment and show what failed',
        session: ({ test }) => test,
        jobs: temporaryTestJobs,
        view:
          ({ test }) =>
          (props) =>
            createElement(TestPanel, { ...props, session: test }),
      },
      sessions
    ),
  (sessions): DevChatCommand =>
    devCommand(
      {
        name: 'optimize',
        description: 'TEMPORARY: tune this agent against an experiment and review the changes',
        session: ({ optimize }) => optimize,
        jobs: temporaryOptimizeJobs,
        view:
          ({ optimize }) =>
          (props) =>
            createElement(OptimizePanel, { ...props, session: optimize }),
      },
      sessions
    ),
]

const targetWorkspace = (workspace: DevWorkspace, project: ImportedAgentProject): DevWorkspace => ({
  ...workspace,
  root: project.root,
  entrypoint: project.entrypoint,
  config: { ...workspace.config, language: project.language },
})

export const temporaryDevChatPart = (
  workspace: DevWorkspace,
  project: ImportedAgentProject,
  agent: () => TemporaryAgentFacts
): DevChatPart => {
  const target = targetWorkspace(workspace, project)
  return temporaryAgentTools({
    sessions: () => temporaryDevSessions({ workspace: target, agent }),
    evaluators: () => readTemporaryEvaluators(target),
  })
}

export const temporaryDevCommands = (
  workspace: DevWorkspace,
  project: ImportedAgentProject,
  agent: () => TemporaryAgentFacts = () => ({})
): DevChatCommand[] => {
  const target = targetWorkspace(workspace, project)
  const sessions: Sessions = (context) =>
    temporaryDevSessions({ workspace: target, agent, ...(context ? { context } : {}) })
  return PANEL_COMMANDS.map((make) => make(sessions))
}
