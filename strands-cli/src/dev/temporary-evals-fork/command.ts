import { createElement } from 'react'

import type { ImportedAgentProject } from '../../project/import.js'
import type { DevChatCommand, DevChatCommandContext, DevChatPanelView } from '../../ui/chat/types.js'
import { DatasetPanel } from '../panels/dataset.js'
import { OptimizePanel } from '../panels/optimize.js'
import { TestPanel } from '../panels/test.js'
import type { DevWorkspace } from '../workspace.js'
import type { TemporaryAgentFacts } from './agent-context.js'
import type { TemporaryJobNotice } from './jobs.js'
import { temporaryDevSessions, type TemporaryDevSessions } from './sessions.js'

interface PanelCommand {
  readonly name: string
  readonly description: string
  readonly view: (sessions: TemporaryDevSessions) => DevChatPanelView
  readonly notice: (sessions: TemporaryDevSessions) => TemporaryJobNotice
  readonly show: (sessions: TemporaryDevSessions) => void
}

const PANEL_COMMANDS: readonly PanelCommand[] = [
  {
    name: 'experiment',
    description: 'TEMPORARY: draft, review, and save test cases for this agent',
    view:
      ({ dataset }) =>
      (props) =>
        createElement(DatasetPanel, { ...props, session: dataset, command: 'experiment' }),
    notice: ({ dataset }) => dataset.notice,
    show: ({ dataset }) => dataset.show(),
  },
  {
    name: 'test',
    description: 'TEMPORARY: run this agent on its test cases and show what failed',
    view:
      ({ test }) =>
      (props) =>
        createElement(TestPanel, { ...props, session: test }),
    notice: ({ test }) => test.notice,
    show: ({ test }) => test.show(),
  },
  {
    name: 'optimize',
    description: 'TEMPORARY: tune this agent against its test cases and review the changes',
    view:
      ({ optimize }) =>
      (props) =>
        createElement(OptimizePanel, { ...props, session: optimize }),
    notice: ({ optimize }) => optimize.notice,
    show: ({ optimize }) => optimize.show(),
  },
]

const targetWorkspace = (workspace: DevWorkspace, project: ImportedAgentProject): DevWorkspace => ({
  ...workspace,
  root: project.root,
  entrypoint: project.entrypoint,
  config: { ...workspace.config, language: project.language },
})

export const temporaryDevCommands = (
  workspace: DevWorkspace,
  project: ImportedAgentProject,
  agent: () => TemporaryAgentFacts = () => ({})
): DevChatCommand[] => {
  const target = targetWorkspace(workspace, project)
  const sessions = (context: DevChatCommandContext): TemporaryDevSessions =>
    temporaryDevSessions({ workspace: target, agent, context })
  return PANEL_COMMANDS.map(({ name, description, view, notice, show }) => ({
    spec: { name, usage: `/${name}`, description },
    open: (context): DevChatPanelView => {
      const opened = sessions(context)
      show(opened)
      return view(opened)
    },
    attach: (context) => notice(sessions(context)).attach(context),
  }))
}
