import { createElement } from 'react'

import type { ImportedAgentProject } from '../../project/import.js'
import type {
  DevChatCommand,
  DevChatCommandContext,
  DevChatJob,
  DevChatPanelView,
  DevPanelOpening,
} from '../../ui/chat/types.js'
import { ExperimentPanel } from '../panels/experiment.js'
import { TestPanel } from '../panels/test.js'
import { WizardRequestPanel } from '../../ui/panels/wizard-request-panel.js'
import type { DevChatPart } from '../chat-extension.js'
import type { DevWorkspace } from '../workspace.js'
import type { TemporaryAgentFacts } from './agent-context.js'
import { temporaryDevChatPart as temporaryAgentTools } from './agent-tools.js'
import { readTemporaryEvaluators } from './evaluators.js'
import { temporaryGenerationJobs } from './experiments-session.js'
import { temporaryJobsFeed, type TemporaryStore } from './jobs.js'
import { temporarySessionHistory } from './session-converter.js'
import { temporaryDevSessions, temporaryTestJobs, type TemporaryDevSessions } from './sessions.js'

interface PanelSession<State> extends TemporaryStore<State> {
  show(): void
}

interface PanelCommand<State> {
  readonly name: string
  readonly description: string
  readonly details: string
  readonly session: (sessions: TemporaryDevSessions) => PanelSession<State>
  readonly jobs: (state: State) => readonly DevChatJob[]
  readonly view: (sessions: TemporaryDevSessions, opening?: DevPanelOpening) => DevChatPanelView
  readonly openJob?: (sessions: TemporaryDevSessions, job: string) => void
  readonly resume?: (sessions: TemporaryDevSessions) => Promise<void>
}

type Sessions = (context?: DevChatCommandContext) => TemporaryDevSessions

const paragraphs = (...lines: readonly string[]): string => lines.join('\n\n')

const EXPERIMENT_DETAILS = paragraphs(
  'An experiment is a set of test cases for this agent. Each case has an input, and it can have an expected output. The evaluators of the experiment give each answer a score.',
  'Select New experiment, and tell the agent in the chat what to test. Before it starts, the agent asks for your approval. Then it makes the cases with an AWS Bedrock model and saves them in strands-dev/experiments/<name>/<name>.json. Generation makes paid model calls and can take minutes. Your chat model does not change.',
  'While the agent makes the cases, a line below the chat input shows the progress. Click the line to open this panel. Generation stops if strands dev closes.',
  'Open a saved experiment to review its cases. You can drop, edit, or add cases, and then save the experiment. When a generation fails, open it to see why. Then try it again, or fix the problem in the chat.',
  'Use /evaluate to run the agent on an experiment, and /optimize to tune the agent against it. You can also ask the agent in plain words, for example "what experiments do I have?"',
  'Experimental: a fork of strands-evals makes the cases for now.'
)

const EVALUATE_DETAILS = paragraphs(
  'Run this agent on the cases of one or more experiments. The evaluators of each experiment give each answer a score.',
  'Select one or more experiments, and start the evaluation. While it runs, a line below the chat input shows the progress. You can stop the evaluation from the panel.',
  'The evaluation continues when you close the panel or strands dev. When strands dev opens again, it shows the results, or it continues the evaluation from where it stopped. On Windows, the evaluation stops when strands dev closes, and continues at the next start.',
  'When the evaluation is done, open its report. The report shows each case as passed or failed. Open a case to read its input, the expected output, the output of the agent, and the score and reason from each evaluator. You can run the failed cases again, or all the cases.',
  'An evaluation does not change the agent source. It makes paid model calls and can take minutes. strands dev saves each report in strands-dev/experiments/<name>/runs/, and the latest one as <name>.report.json.',
  'From a shell, strands dev evaluate <experiment> runs the same evaluation and prints the result.',
  'Experimental: a fork of strands-evals runs the evaluations for now.'
)

const devCommand = <State>(
  { name, description, details, session, jobs, view, openJob, resume }: PanelCommand<State>,
  sessions: Sessions
): DevChatCommand => ({
  spec: { name, usage: `/${name}`, description, details },
  open: (context, opening): DevChatPanelView => {
    const opened = sessions(context)
    if (!opening?.restore) session(opened).show()
    if (opening?.job) openJob?.(opened, opening.job)
    return view(opened, opening)
  },
  attach: (context): void => void resume?.(sessions(context)),
  jobs: temporaryJobsFeed(session(sessions()), jobs),
})

const PANEL_COMMANDS: readonly ((sessions: Sessions) => DevChatCommand)[] = [
  (sessions): DevChatCommand =>
    devCommand(
      {
        name: 'experiment',
        description: 'Generate test cases for this agent with strands-evals, and review them',
        details: EXPERIMENT_DETAILS,
        session: ({ experiments }) => ({
          subscribe: experiments.subscribe,
          snapshot: experiments.snapshot,
          show: () => experiments.refresh(),
        }),
        jobs: temporaryGenerationJobs,
        resume: async ({ ui }) => ui.start(),
        view:
          ({ experiments, ui }) =>
          (props) =>
            createElement(ExperimentPanel, { ...props, session: experiments, browser: ui }),
      },
      sessions
    ),
  (sessions): DevChatCommand =>
    devCommand(
      {
        name: 'evaluate',
        description: 'Run this agent on an experiment and show what failed',
        details: EVALUATE_DETAILS,
        session: ({ test }) => test,
        jobs: temporaryTestJobs,
        resume: ({ test }) => test.resume(),
        view:
          ({ test, ui }, opening) =>
          (props) =>
            createElement(TestPanel, {
              ...props,
              session: test,
              browser: ui,
              ...(opening?.job ? { initialRun: opening.job } : {}),
            }),
      },
      sessions
    ),
]

const ASK_DETAILS = paragraphs(
  'Shows the question that the agent is asking about a run it wants to set up.',
  'The agent sends the steps and the fields, so each question looks like the flow it is guiding you through. Tab and Shift+Tab move between steps, ↑↓ go to a row, and ←→ move a slider. Enter on a text row edits it.',
  'Finish sends your answers back to the agent, and Cancel tells it you declined. One question shows at a time; a second one waits.',
  'Open /ask again to return to a question you left.'
)

const askCommand = (sessions: Sessions): DevChatCommand => ({
  sticky: true,
  dropPending: () => sessions().ask.cancelAll(),
  spec: {
    name: 'ask',
    usage: '/ask',
    description: 'Answer the setup question that the agent is asking',
    details: ASK_DETAILS,
  },
  open:
    (context): DevChatPanelView =>
    (props) =>
      createElement(WizardRequestPanel, {
        ...props,
        broker: sessions(context).ask,
        onAutofill: (on) =>
          void context.report(
            'success',
            on
              ? 'Autofill on · the agent answers its own questions with their defaults'
              : 'Autofill off · the agent asks, and you answer on screen'
          ),
      }),
  attach: (context): void => {
    const opened = sessions(context)
    opened.ask.attachOpener(() => context.openPanel('ask'))
    void opened.optimize.resume()
  },
})

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
    history: temporarySessionHistory({ workspace: target, agent }),
  })
}

export const temporaryDevCommands = (
  workspace: DevWorkspace,
  project: ImportedAgentProject,
  agent: () => TemporaryAgentFacts = () => ({}),
  autofill?: () => boolean
): DevChatCommand[] => {
  const target = targetWorkspace(workspace, project)
  const sessions: Sessions = (context) =>
    temporaryDevSessions({
      workspace: target,
      agent,
      ...(autofill ? { autofill } : {}),
      ...(context ? { context } : {}),
    })
  return [...PANEL_COMMANDS.map((make) => make(sessions)), askCommand(sessions)]
}
