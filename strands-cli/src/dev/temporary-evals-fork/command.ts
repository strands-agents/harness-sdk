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
import { temporarySessionHistory } from './session-converter.js'
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
  readonly details: string
  readonly session: (sessions: TemporaryDevSessions) => PanelSession<State>
  readonly jobs: (state: State) => readonly DevChatJob[]
  readonly view: (sessions: TemporaryDevSessions) => DevChatPanelView
  readonly resume?: (sessions: TemporaryDevSessions) => Promise<void>
}

type Sessions = (context?: DevChatCommandContext) => TemporaryDevSessions

const paragraphs = (...lines: readonly string[]): string => lines.join('\n\n')

const EXPERIMENT_DETAILS = paragraphs(
  'An experiment is a set of test cases for this agent. Each case has an input, and it can have an expected output. The evaluators of the experiment give each answer a score.',
  'Select New experiment, and tell the agent in the chat what to test. Before it starts, the agent asks for your approval. Then it makes the cases with an AWS Bedrock model and saves them in strands-dev/tmp/experiments/<name>/<name>.json. Generation makes paid model calls and can take minutes. Your chat model does not change.',
  'While the agent makes the cases, a line below the chat input shows the progress. Click the line to open this panel. Generation stops if strands dev closes.',
  'Open a saved experiment to review its cases. You can drop, edit, or add cases, and then save the experiment. When a generation fails, open it to see why. Then try it again, or fix the problem in the chat.',
  'Use /test to run the agent on an experiment, and /optimize to tune the agent against it. You can also ask the agent in plain words, for example "what experiments do I have?"',
  'TEMPORARY: a fork of strands-evals makes the cases for now.'
)

const TEST_DETAILS = paragraphs(
  'Run this agent on the cases of one or more experiments. The evaluators of each experiment give each answer a score.',
  'Select one or more experiments, and start the test. While it runs, a line below the chat input shows the progress. You can stop the test from the panel.',
  'The test continues when you close the panel or strands dev. When strands dev opens again, it shows the results, or it continues the test from where it stopped. On Windows, the test stops when strands dev closes, and continues at the next start.',
  'When the test is done, open its report. The report shows each case as passed or failed. Open a case to read its input, the expected output, the output of the agent, and the score and reason from each evaluator. You can run the failed cases again, or all the cases.',
  'A test does not change the agent source. It makes paid model calls and can take minutes. strands dev saves each report in strands-dev/tmp/experiments/<name>/runs/, and the latest one as <name>.report.json.',
  'From a shell, strands dev test <experiment> runs the same test and prints the result.',
  'TEMPORARY: a fork of strands-evals runs the tests for now.'
)

const OPTIMIZE_DETAILS = paragraphs(
  'Tune this agent against an experiment, and then review the changes that the optimizer proposes.',
  'Select an experiment, and then select the knobs to tune. Each option of the createHarness or create_harness call is a knob, for example the instructions, the model, the effort, the tools, and the skills. For the model, select the other models to try. A knob that strands dev cannot change shows the reason.',
  'Use ↑↓ to go to the cases or the budget slider, and ←→ to move the selected slider. The cases slider sets how many cases are for training, validation, and test. Then select Start. Before you start, the panel shows about how many model calls the run makes.',
  'The optimizer divides the cases into training, validation, and test cases. It tries candidate changes on the training cases. The best candidate on the validation cases wins, and the test cases measure it at the end.',
  'While it runs, the panel shows the baseline score, the best score, and each candidate. Stop the run to keep the best candidate so far. Esc goes back to the /optimize list, and the run continues. You can start other runs at the same time.',
  'The run continues when you close the panel or strands dev. When strands dev opens again, the list shows the finished run, or the run continues from where it stopped. On Windows, the run stops when strands dev closes, and continues at the next start.',
  'At the end, review each proposed edit. ←→ selects an edit, and ↑↓ scrolls its change. Accept or reject each edit, and then apply the accepted edits. The agent source does not change until you apply them. Then use /test on the new version.',
  'The test check shows the gain on test cases that the search did not use, and its 90% confidence range. If the range includes 0, the gain can be luck.',
  '/optimize always opens the list. The list shows the runs that go on, and the past runs. Select a run to see its progress or to open its report again.',
  'A run makes many paid model calls and can take a long time. strands dev saves the records in strands-dev/tmp/experiments/<name>/optimizations/. From a shell, strands dev optimize <experiment> runs the optimizer and prints the result, but it does not change the agent source.',
  'TEMPORARY: a fork of strands-evals runs the upstream optimizer for now.'
)

const devCommand = <State>(
  { name, description, details, session, jobs, view, resume }: PanelCommand<State>,
  sessions: Sessions
): DevChatCommand => ({
  spec: { name, usage: `/${name}`, description, details },
  open: (context, opening): DevChatPanelView => {
    const opened = sessions(context)
    if (!opening?.restore) session(opened).show()
    return view(opened)
  },
  attach: (context): void => void resume?.(sessions(context)),
  jobs: temporaryJobsFeed(session(sessions()), jobs),
})

const PANEL_COMMANDS: readonly ((sessions: Sessions) => DevChatCommand)[] = [
  (sessions): DevChatCommand =>
    devCommand(
      {
        name: 'experiment',
        description: 'TEMPORARY: generate test cases for this agent with strands-evals, and review them',
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
        name: 'test',
        description: 'TEMPORARY: run this agent on an experiment and show what failed',
        details: TEST_DETAILS,
        session: ({ test }) => test,
        jobs: temporaryTestJobs,
        resume: ({ test }) => test.resume(),
        view:
          ({ test, ui }) =>
          (props) =>
            createElement(TestPanel, { ...props, session: test, browser: ui }),
      },
      sessions
    ),
  (sessions): DevChatCommand =>
    devCommand(
      {
        name: 'optimize',
        description: 'TEMPORARY: tune this agent against an experiment and review the changes',
        details: OPTIMIZE_DETAILS,
        session: ({ optimize }) => optimize,
        jobs: temporaryOptimizeJobs,
        view:
          ({ optimize, ui }) =>
          (props) =>
            createElement(OptimizePanel, { ...props, session: optimize, browser: ui }),
        resume: ({ optimize }) => optimize.resume(),
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
    history: temporarySessionHistory({ workspace: target, currentChat: () => agent().sessionId }),
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
