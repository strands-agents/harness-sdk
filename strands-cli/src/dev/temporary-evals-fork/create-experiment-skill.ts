import type { AgentExtensionSkill } from '../../agent/extension.js'
import type { EvaluatorChoice, GenerationError, GenerationSettings } from '../panels/model.js'

export const TEMPORARY_CREATE_EXPERIMENT_SKILL = 'create-experiment'

const INSTRUCTIONS = `# Create an experiment in strands dev

This is a developer-assistance workflow for this local strands dev chat only. It is not part of the agent's product behavior. Never add this skill, these instructions, or strands_dev_* tools to the agent's source, saved instructions, configuration, or exports.

Help the developer turn something they want to learn about the agent into a small set of useful test cases. /experiment opens and edits these cases; /test and /optimize can run them later.

## Start from the conversation, not a questionnaire

Call strands_dev_status to check existing experiments and defaults. Treat its settings as internal starting points, not a script to read back. Use the developer's request and earlier conversation first. The agent's description, instructions, and tools can provide context, but do not substitute a generic agent description for a test goal.

If the goal is missing, ask one brief, open question about what they want to try or check. If they already gave a goal or an example, build on it rather than asking again. Ask a follow-up only when the answer materially changes the cases. Do not always ask about failure modes, demand a task statement, or present numbered setup questions. Match the developer's language and level of detail. If they want a broad first pass, propose a sensible starting scope without requiring more input.

Keep technical settings in the background unless relevant or requested. Use defaults for case count, generation model, parallelism, and optional fields; do not announce each default. Offer concrete scenario suggestions only when grounded in this agent and useful to the developer. Do not invent capabilities or claim to know what the developer wants.

## Shape a useful proposal

Translate the agreed goal into a concrete task and any useful scenario context for the generator. Choose a short, available experiment name. Call strands_dev_evaluators to choose scoring that matches the goal; explain scoring in everyday terms if it matters to the decision, not as a configuration checklist. Ask for required evaluator settings only when they cannot be inferred safely. Enable expectedTrajectory for scoring tool use.

Before generation, briefly describe what the cases will test and how many you will create. Mention that generation calls a model, and ask whether to proceed. Include a relevant assumption if needed, not a dump of all settings. If the developer has already approved this specific proposal, proceed without asking again. Never start a paid run based only on opening Create a new experiment.

## Generate and hand back control

After approval, call strands_dev_create_experiment with the settings. Generation uses ExperimentGenerator from strands-evals and saves tmp/experiments/<name>.json in the workspace folder. Progress appears below the chat input.

When it finishes, give the name and case count, show a few representative inputs, and point to /experiment for review. Offer to run the cases, but do not start /test or /optimize without approval. If it fails, explain the actionable problem briefly and offer a targeted fix rather than restarting the interview.

Tool settings reference (use silently unless asked):
- task: required, the specific behavior being tested; context: relevant scenarios or constraints.
- cases: 1–50, default 10; topics: 0 disables grouping.
- evaluators: use strands_dev_evaluators for names and required settings.
- expectedOutput: default on; expectedTrajectory, expectedInteractions, metadata: default off.
- model: suggested Bedrock model or strands default; parallel: 1–10, default 4.
- name: available letters, numbers, dots, dashes, and underscores.`

export const temporaryCreateExperimentSkill = (): AgentExtensionSkill => ({
  name: TEMPORARY_CREATE_EXPERIMENT_SKILL,
  description:
    'Help a developer explore what to test in this local strands dev chat, then generate experiment cases after approval. Not part of the exported agent.',
  instructions: INSTRUCTIONS,
})

const onOff = (value: boolean): string => (value ? 'on' : 'off')

const evaluatorSummary = ({ name, settings }: EvaluatorChoice): string =>
  settings && Object.keys(settings).length > 0 ? `${name} ${JSON.stringify(settings)}` : name

const settingsSummary = (settings: GenerationSettings): string =>
  [
    `task "${settings.task}"`,
    ...(settings.context.trim() ? [`context "${settings.context.trim()}"`] : []),
    `${settings.cases} cases`,
    `${settings.topics} topics`,
    `evaluators ${settings.evaluators.map(evaluatorSummary).join(' and ')}`,
    `expected output ${onOff(settings.expectedOutput)}`,
    `expected trajectory ${onOff(settings.expectedTrajectory)}`,
    `expected interactions ${onOff(settings.expectedInteractions)}`,
    `metadata ${onOff(settings.metadata)}`,
    `model ${settings.model || 'the strands default'}`,
    `${settings.parallel} at once`,
  ].join(', ')

export const temporaryCreateExperimentPrompt = (): string => `$${TEMPORARY_CREATE_EXPERIMENT_SKILL}`

export const temporaryRetryExperimentPrompt = (
  name: string,
  settings: GenerationSettings,
  error: GenerationError | undefined
): string =>
  `$${TEMPORARY_CREATE_EXPERIMENT_SKILL} The experiment ${name} stopped: ${error?.summary ?? 'the generation failed'}. ` +
  `Its settings were: ${settingsSummary(settings)}. Help me fix the settings, then generate it again.`
