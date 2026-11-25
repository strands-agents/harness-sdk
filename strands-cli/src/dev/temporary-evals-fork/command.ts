import { createElement } from 'react'

import type { ImportedAgentProject } from '../../project/import.js'
import type { AgentExtensionUrlSkill } from '../../agent/extension.js'
import type { DevChatCommand, DevChatCommandContext, DevChatPanelView, DevChatSkillRun } from '../../ui/chat/types.js'
import { WizardRequestPanel } from '../../ui/panels/wizard-request-panel.js'
import { wizardRequestHasDiff, wizardRequestRows } from '../../ui/panels/wizard-request.js'
import type { DevChatPart } from '../chat-extension.js'
import { STRANDS_EVALS_LABEL } from '../evals-package.js'
import { evalsSkillUnavailable, STRANDS_EVALS_OPTIMIZE_SKILL, STRANDS_EVALS_SKILL } from '../evals-skill.js'
import type { DevWorkspace } from '../workspace.js'
import { startTemporaryOptimizationWithDefaults, temporaryDevChatPart as temporaryAgentTools } from './agent-tools.js'
import {
  AUTO_OPTIMIZE_JOB,
  autoOptimizeJobs,
  autoOptimizeRun,
  type AutoOptimizeRun,
  type AutoOptimizeRunOptions,
} from './auto-optimize.js'
import { temporaryGenerationJobs } from './experiments-session.js'
import type { TemporaryAgentFacts, TemporaryDevSettings } from './host.js'
import { mergedJobsFeed, temporaryJobsFeed } from './jobs.js'
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
  'The agent lists the saved experiments, Run several experiments, and Create a new experiment. Pick a saved experiment to view its last report, run it, or edit its cases. Running makes paid model calls; picking Run is the approval, and a line below the chat input shows the progress. The report gives the passed and failed cases and the reason each failure got, and the evals UI shows the whole of it.',
  'Edit opens the experiment in your editor ($STRANDS_EDITOR, $VISUAL, or $EDITOR, as /config uses), and the agent asks what to change. When a generation fails, the agent says why and offers to try again.',
  'A run continues when you cancel the chat turn or close strands dev, and continues from where it stopped at the next start. strands dev saves each report in strands-dev/experiments/<name>/runs/, and the latest as <name>.report.json. From a shell, strands dev evaluate <experiment> runs the same evaluation and prints the result.',
  'Use /optimize to tune the agent against an experiment. You can also ask the agent in plain words, for example "what experiments do I have?"',
  `Experimental: strands dev makes and runs the cases with ${STRANDS_EVALS_LABEL}.`
)

const OPTIMIZE_DETAILS = paragraphs(
  'Tune this agent against an experiment, and then review the changes that the optimizer proposes.',
  '/optimize activates the optimize skill of strands-evals, and the agent asks on screen, one question at a time, which experiment to use, which knobs to tune, what the run should improve, what must stay true, and the budget. Add what you want to skip questions, for example /optimize refunds for fewer tokens.',
  'The knobs are options of the createHarness or create_harness call: the instructions or the system prompt, the model, the effort, prompt caching, the context manager, background tasks, and each skill, tool, built-in tool, MCP server, plugin, built-in plugin, and intervention on or off. An option that the call leaves out starts from the strands-harness default, and accepting its edit writes the option into the call. A knob that strands dev cannot change shows the reason. Session and memory are not knobs: every trial runs without them.',
  'Then the agent prints a review of every setting in chat, with the estimated rollouts and judge calls, and waits for your reply. Name a setting to change it, or approve the review to start the run; a run makes many paid model calls and can take a long time.',
  'The optimizer divides the cases into training, validation, and test cases. It tries candidate changes on the training cases. The best candidate on the validation cases wins, and the test cases measure it at the end.',
  'While it runs, a line below the chat input shows the progress. Click the line to ask about it, or ask the agent to stop the run and keep the best candidate so far. You can start other runs at the same time.',
  'The run continues when you cancel the chat turn or close strands dev. When strands dev opens again, the run continues from where it stopped. On Windows, the run stops when strands dev closes, and continues at the next start.',
  'The run goes on in the background, and a notice says when it finishes. Then its proposed edits appear on screen as a diff, one edit at a time: pick Apply this change or Leave it as it is. The agent source changes once every edit has an answer, and only with the edits you applied. Then run the experiment again from /experiment. Ask the agent to open the run in the evals UI for a closer look.',
  'While a diff is on screen you can also answer it in the chat: say "approve this" or "leave it", and the agent picks that choice for you. Any other message leaves the diff where it is.',
  'Esc closes a diff without an answer. The run stays on the line below the chat input, also after strands dev opens again, and clicking that line, or asking the agent, shows the diff again.',
  'With Auto-accept optimization results on in /settings, a run that finishes writes its edits to the agent source without showing them. A run that you stopped still shows its edits for review.',
  'strands dev saves the records in strands-dev/experiments/<name>/optimizations/. From a shell, strands dev optimize <experiment> runs the optimizer and prints the result, but it does not change the agent source.',
  `Experimental: strands dev runs the optimizer of ${STRANDS_EVALS_LABEL}, with strands-evals optimize run and strands-evals optimize resume.`
)

const evalsSkill = (
  workflow: DevChatSkillRun['workflow'],
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

const EVALS_COMMANDS: readonly ((sessions: Sessions, auto: AutoOptimizeRun) => DevChatCommand)[] = [
  (sessions): DevChatCommand => ({
    spec: {
      name: 'experiment',
      usage: '/experiment',
      description: 'Make, run, and review the test cases of this agent with the strands-evals skill',
      details: EXPERIMENT_DETAILS,
    },
    skill: evalsSkill(temporaryCommandWorkflows.experiment, (id) => {
      // One line carries both kinds of job: a generation has an id of its own, an evaluation the experiment path.
      const generation = generationName(sessions, id)
      if (generation !== undefined) return `how is the generation of ${generation} going?`
      return `how is the evaluation of ${evaluationName(sessions, id) ?? 'the experiment'} going?`
    }),
    attach: (context): void => {
      const opened = sessions(context)
      void opened.ui.start()
      void opened.test.resume()
    },
    jobs: mergedJobsFeed(
      temporaryJobsFeed(sessions().experiments, temporaryGenerationJobs),
      temporaryJobsFeed(sessions().test, temporaryTestJobs)
    ),
    backgroundTools: BACKGROUND_TOOLS,
  }),
  (sessions, auto): DevChatCommand => ({
    spec: {
      name: 'optimize',
      usage: '/optimize',
      description: 'Tune this agent against an experiment with the optimize skill and review the changes',
      details: OPTIMIZE_DETAILS,
    },
    skill: evalsSkill(
      temporaryCommandWorkflows.optimize,
      (id) =>
        id === AUTO_OPTIMIZE_JOB
          ? 'how is the automatic optimization going?'
          : `how is the optimization of ${optimizationName(sessions, id) ?? 'the experiment'} going?`,
      STRANDS_EVALS_OPTIMIZE_SKILL
    ),
    attach: (context): void => {
      const { optimize, auto: counting } = sessions(context)
      optimize.reannounce()
      counting.reannounce()
      void optimize.resume()
    },
    // Auto-optimize counts the chat turns. When the cadence comes round, its work goes on away from the chat.
    turnEnded: (context, turn): void => void sessions(context).auto.turnEnded(turn, auto),
    jobs: mergedJobsFeed(
      temporaryJobsFeed(sessions().auto, autoOptimizeJobs),
      temporaryJobsFeed(sessions().optimize, temporaryOptimizeJobs)
    ),
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
    history: temporarySessionHistory({ workspace: target, agent }),
  })
}

/** The parts of an automatic optimization that a test puts its own in place of. */
export const temporaryDevCommands = (
  workspace: DevWorkspace,
  project: ImportedAgentProject,
  agent: () => TemporaryAgentFacts = () => ({}),
  settings?: () => TemporaryDevSettings,
  autoOptimize: Partial<Pick<AutoOptimizeRunOptions, 'worker' | 'history' | 'now'>> = {}
): DevChatCommand[] => {
  const target = targetWorkspace(workspace, project)
  const sessions: Sessions = (context) =>
    temporaryDevSessions({
      workspace: target,
      agent,
      ...(settings ? { settings } : {}),
      ...(context ? { context } : {}),
    })
  const auto = autoOptimizeRun({
    workspace: target,
    history: temporarySessionHistory({ workspace: target, agent }),
    start: (experiment) => startTemporaryOptimizationWithDefaults(sessions, experiment),
    ...autoOptimize,
  })
  return [...EVALS_COMMANDS.map((make) => make(sessions, auto)), askCommand(sessions)]
}
