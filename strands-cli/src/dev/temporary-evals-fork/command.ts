import { createElement } from 'react'

import type { ImportedAgentProject } from '../../project/import.js'
import type { AgentExtensionUrlSkill } from '../../agent/extension.js'
import type { DevChatCommand, DevChatCommandContext, DevChatPanelView, DevChatSkillRun } from '../../ui/chat/types.js'
import { WizardRequestPanel } from '../../ui/panels/wizard-request-panel.js'
import { wizardRequestHasDiff, wizardRequestRows } from '../../ui/panels/wizard-request.js'
import type { DevChatPart } from '../chat-extension.js'
import { evalsSkillUnavailable, STRANDS_EVALS_OPTIMIZE_SKILL, STRANDS_EVALS_SKILL } from '../evals-skill.js'
import type { DevWorkspace } from '../workspace.js'
import type { TemporaryAgentFacts } from './agent-context.js'
import { temporaryDevChatPart as temporaryAgentTools } from './agent-tools.js'
import { readTemporaryEvaluators } from './evaluators.js'
import { temporaryGenerationJobs } from './experiments-session.js'
import { temporaryJobsFeed } from './jobs.js'
import { optimizeReviewContext, showOptimizeReview } from './review-run.js'
import { temporarySessionHistory } from './session-converter.js'
import { temporaryCommandWorkflows } from './workflow-skills.js'
import {
  temporaryDevSessions,
  temporaryOptimizeJobs,
  temporaryRunAwaitsReview,
  temporaryTestJobs,
  type TemporaryDevSessions,
} from './sessions.js'

type Sessions = (context?: DevChatCommandContext) => TemporaryDevSessions

const paragraphs = (...lines: readonly string[]): string => lines.join('\n\n')

const EXPERIMENT_DETAILS = paragraphs(
  'An experiment is a set of test cases for this agent. Each case has an input, and it can have an expected output. The evaluators of the experiment give each answer a score.',
  '/experiment activates the strands-evals skill, and the agent asks on screen, one question at a time, which experiment to open, or how to make a new one. Add what you want to skip questions, for example /experiment refunds or /experiment make cases from my past chats.',
  'For a new experiment, the agent asks what to test and asks for your approval. Then it makes the cases with an AWS Bedrock model and saves them in strands-dev/experiments/<name>/<name>.json. Generation makes paid model calls and can take minutes. Your chat model does not change.',
  'The agent runs strands-evals generate in the background, and a line below the chat input shows the progress. Click the line to ask about it. Generation stops if strands dev closes.',
  'The agent lists the saved experiments and Create a new experiment. A saved experiment opens in your editor ($STRANDS_EDITOR, $VISUAL, or $EDITOR, as /config uses), and the agent asks what to change. You can also view and edit it in the evals UI. For a new experiment, the agent asks whether to describe a task or to build the cases from past chats. When a generation fails, the agent says why and offers to try again.',
  'Use /evaluate to run the agent on an experiment, and /optimize to tune the agent against it. You can also ask the agent in plain words, for example "what experiments do I have?"',
  'Experimental: a fork of strands-evals makes the cases for now.'
)

const EVALUATE_DETAILS = paragraphs(
  'Run this agent on the cases of one or more experiments. The evaluators of each experiment give each answer a score.',
  '/evaluate activates the strands-evals skill, and the agent asks on screen which experiments and cases to run. It names the run in chat, and starts it when you approve it in your reply; it makes paid model calls. Add what you want to skip questions, for example /evaluate refunds or /evaluate rerun the failures.',
  'While it runs, a line below the chat input shows the progress. Click the line to ask about it, or ask the agent to stop the evaluation.',
  'The evaluation continues when you cancel the chat turn or close strands dev. When it is done, a notice gives the path of its report, or of its run log when it stopped. When strands dev opens again, it posts that notice, or it continues the evaluation from where it stopped. On Windows, the evaluation stops when strands dev closes, and continues at the next start.',
  'The evals UI shows each report: every case as passed or failed, and for a failed case its input, the expected output, the output of the agent, and the reason from each evaluator.',
  'An evaluation does not change the agent source. It makes paid model calls and can take minutes. strands dev saves each report in strands-dev/experiments/<name>/runs/, and the latest one as <name>.report.json.',
  'From a shell, strands dev evaluate <experiment> runs the same evaluation and prints the result.',
  'Experimental: a fork of strands-evals runs the evaluations for now.'
)

const OPTIMIZE_DETAILS = paragraphs(
  'Tune this agent against an experiment, and then review the changes that the optimizer proposes.',
  '/optimize activates the optimize skill of strands-evals, and the agent asks on screen, one question at a time, which experiment to use, which knobs to tune, what the run should improve, what must stay true, and the budget. Add what you want to skip questions, for example /optimize refunds for fewer tokens.',
  'The knobs are options of the createHarness or create_harness call: the instructions or the system prompt, the model, the effort, prompt caching, the context manager, background tasks, and each skill, tool, built-in tool, MCP server, plugin, built-in plugin, and intervention on or off. An option that the call leaves out starts from the strands-harness default, and accepting its edit writes the option into the call. A knob that strands dev cannot change shows the reason. Session and memory are not knobs: every trial runs without them.',
  'Then the agent prints a review of every setting in chat, with the estimated rollouts and judge calls, and waits for your reply. Name a setting to change it, or approve the review to start the run; a run makes many paid model calls and can take a long time.',
  'The optimizer divides the cases into training, validation, and test cases. It tries candidate changes on the training cases. The best candidate on the validation cases wins, and the test cases measure it at the end.',
  'While it runs, a line below the chat input shows the progress. Click the line to ask about it, or ask the agent to stop the run and keep the best candidate so far. You can start other runs at the same time.',
  'The run continues when you cancel the chat turn or close strands dev. When strands dev opens again, the run continues from where it stopped. On Windows, the run stops when strands dev closes, and continues at the next start.',
  'The run goes on in the background, and a notice says when it finishes. Then its proposed edits appear on screen as a diff, one edit at a time: pick Apply this change or Leave it as it is. The agent source changes once every edit has an answer, and only with the edits you applied. Then use /evaluate on the new version. Ask the agent to open the run in the evals UI for a closer look.',
  'While a diff is on screen you can also answer it in the chat: say "approve this" or "leave it", and the agent picks that choice for you. Any other message leaves the diff where it is.',
  'Esc closes a diff without an answer. The run stays on the line below the chat input, also after strands dev opens again, and clicking that line, or asking the agent, shows the diff again.',
  'With Auto-optimize (apply edits) on in /settings, a run that finishes writes its edits to the agent source without showing them. A run that you stopped still shows its edits for review.',
  'strands dev saves the records in strands-dev/experiments/<name>/optimizations/. From a shell, strands dev optimize <experiment> runs the optimizer and prints the result, but it does not change the agent source.',
  'Experimental: a fork of strands-evals runs the upstream optimizer for now, with strands-evals optimize run and strands-evals optimize resume.'
)

const evalsSkill = (
  workflow: string,
  job: (id: string) => string,
  skill: AgentExtensionUrlSkill = STRANDS_EVALS_SKILL
): DevChatSkillRun => ({
  skill: skill.name,
  workflow,
  unavailable: evalsSkillUnavailable(skill),
  job,
})

const generationName = (sessions: Sessions, id: string): string | undefined =>
  sessions()
    .experiments.snapshot()
    .generations.find((generation) => generation.id === id)?.name

const evaluationName = (sessions: Sessions, path: string): string | undefined =>
  sessions()
    .test.snapshot()
    .runs.find(({ experiment }) => experiment.path === path)?.experiment.name

const optimizationName = (sessions: Sessions, id: string): string | undefined =>
  sessions()
    .optimize.snapshot()
    .runs?.find((run) => run.id === id)?.experiment

// The tool that starts each command's work; its jobs line already shows that run, so it is not listed twice.
const BACKGROUND_TOOLS = ['strands_dev_run_background']

const EVALS_COMMANDS: readonly ((sessions: Sessions) => DevChatCommand)[] = [
  (sessions): DevChatCommand => ({
    spec: {
      name: 'experiment',
      usage: '/experiment',
      description: 'Make, review, and edit the test cases of this agent with the strands-evals skill',
      details: EXPERIMENT_DETAILS,
    },
    skill: evalsSkill(
      temporaryCommandWorkflows.experiment,
      (id) => `how is the generation of ${generationName(sessions, id) ?? 'the experiment'} going?`
    ),
    attach: (context): void => void sessions(context).ui.start(),
    jobs: temporaryJobsFeed(sessions().experiments, temporaryGenerationJobs),
    backgroundTools: BACKGROUND_TOOLS,
  }),
  (sessions): DevChatCommand => ({
    spec: {
      name: 'evaluate',
      usage: '/evaluate',
      description: 'Run this agent on an experiment with the strands-evals skill and show what failed',
      details: EVALUATE_DETAILS,
    },
    skill: evalsSkill(
      temporaryCommandWorkflows.evaluate,
      (id) => `how is the evaluation of ${evaluationName(sessions, id) ?? 'the experiment'} going?`
    ),
    attach: (context): void => void sessions(context).test.resume(),
    jobs: temporaryJobsFeed(sessions().test, temporaryTestJobs),
    backgroundTools: BACKGROUND_TOOLS,
  }),
  (sessions): DevChatCommand => ({
    spec: {
      name: 'optimize',
      usage: '/optimize',
      description: 'Tune this agent against an experiment with the optimize skill and review the changes',
      details: OPTIMIZE_DETAILS,
    },
    skill: evalsSkill(
      temporaryCommandWorkflows.optimize,
      (id) => `how is the optimization of ${optimizationName(sessions, id) ?? 'the experiment'} going?`,
      STRANDS_EVALS_OPTIMIZE_SKILL
    ),
    attach: (context): void => {
      const { optimize } = sessions(context)
      optimize.reannounce()
      void optimize.resume()
    },
    jobs: temporaryJobsFeed(sessions().optimize, temporaryOptimizeJobs),
    backgroundTools: BACKGROUND_TOOLS,
    // A finished run's line is its review: open the diff it waits on instead of asking the chat.
    openJob: (context, job): boolean => {
      const opened = sessions(context)
      if (!temporaryRunAwaitsReview(opened.optimize.snapshot(), job)) return false
      return showOptimizeReview(opened, job) && context.openPanel('ask')
    },
  }),
]

const askCommand = (sessions: Sessions): DevChatCommand => ({
  spec: {
    name: 'ask',
    usage: '/ask',
    description: 'Answer the setup question that the agent is asking',
  },
  hidden: true,
  // The chat stays usable while a question waits, and a message drops the question a turn waits on.
  sticky: true,
  // A change is read line by line beside the chat, so it takes the wide dock.
  dock: () => wizardRequestHasDiff(sessions().ask.pending()),
  wideDock: () => wizardRequestHasDiff(sessions().ask.pending()),
  dropPending: () => sessions().ask.interruptForTurn(),
  // A finished run's diff stays on screen when a message is sent, so the message says which diff that was.
  screenContext: () => optimizeReviewContext(sessions()),
  contentRows: (width) => wizardRequestRows(sessions().ask.pending(), width),
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
  attach: (context): void => sessions(context).ask.attachOpener(() => context.openPanel('ask')),
  // A standing question, such as a finished run's diff, is not the turn's, so it stays.
  abandon: (context): void => void sessions(context).ask.dropForTurn(),
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
  autofill?: () => boolean,
  autoOptimize?: () => boolean
): DevChatCommand[] => {
  const target = targetWorkspace(workspace, project)
  const sessions: Sessions = (context) =>
    temporaryDevSessions({
      workspace: target,
      agent,
      ...(autofill ? { autofill } : {}),
      ...(autoOptimize ? { autoOptimize } : {}),
      ...(context ? { context } : {}),
    })
  return [...EVALS_COMMANDS.map((make) => make(sessions)), askCommand(sessions)]
}
