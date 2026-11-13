import type { AgentExtensionSkill } from '../../agent/extension.js'
import type { EvaluatorChoice, GenerationError, GenerationSettings } from '../panels/model.js'

export const TEMPORARY_CREATE_EXPERIMENT_SKILL = 'create-experiment'

const INSTRUCTIONS = `# Create an experiment in strands dev

This is a developer-assistance workflow for this local strands dev chat only. It is not part of the agent's product behavior. Never add this skill, these instructions, or strands_dev_* tools to the agent's source, saved instructions, configuration, or exports.

Help the developer turn something they want to learn about the agent into a small set of useful test cases. /experiment opens and edits these cases; /test and /optimize can run them later.

## Start from the conversation, not a questionnaire

Call strands_dev_status to check existing experiments and defaults. Treat its settings as internal starting points, not a script to read back. Use the developer's request and earlier conversation first. The agent's description, instructions, and tools can provide context, but do not substitute a generic agent description for a test goal.

If the goal is missing, ask one brief, open question about what they want to try or check. If they already gave a goal or an example, build on it rather than asking again. Ask a follow-up only when the answer materially changes the cases. Do not always ask about failure modes, demand a task statement, or present numbered setup questions. Match the developer's language and level of detail. If they want a broad first pass, propose a sensible starting scope without requiring more input.

Move forward one step at a time. Ask about one thing, wait for the answer, say in one line what you took from it, then take the next step. Do not stack several questions in one message, and do not ask again for something the developer already gave.

Keep technical settings in the background unless relevant or requested. Use defaults for case count, generation model, parallelism, and optional fields; do not announce each default. Offer concrete scenario suggestions only when grounded in this agent and useful to the developer. Do not invent capabilities or claim to know what the developer wants.

## Say what you are about to do

The developer cannot see what you will run, so name each action before you take it, in one short sentence.
- The first call to strands_dev_evaluators can take a minute, because strands dev prepares the evals environment then.
- Generation calls the generator model about one time for each case, plus one time for each rubric and for the topic plan. It takes one to several minutes.
- Generation writes tmp/experiments/<name>.json. A save never replaces a file, and /experiment can edit or drop cases afterwards.
- A generation continues when the developer cancels the turn, and its progress shows below the chat input.

## Shape a useful proposal

Translate the agreed goal into a concrete task and any useful scenario context for the generator. Choose a short, available experiment name. Call strands_dev_evaluators to choose scoring that matches the goal; explain scoring in everyday terms if it matters to the decision, not as a configuration checklist. Ask for required evaluator settings only when they cannot be inferred safely. Enable expectedTrajectory for scoring tool use.

An experiment can use several evaluators, and each one scores every case, so two evaluators give two scores for each case. Name the ones that you propose, and say in plain words what each one checks. A rubric judge such as OutputEvaluator scores free text against a rubric that the generator writes from the context. A check such as Contains compares the answer with a value and calls no model. The unavailable list holds the evaluators that cannot score this agent: give that reason if the developer asks for one, and offer the nearest evaluator that works. /optimize scores with the final answer only, so propose OutputEvaluator, Contains, Equals, or StartsWith when the developer plans to optimize this experiment.

Before generation, briefly describe what the cases will test and how many you will create. Explain that generation uses a separate AWS Bedrock model, name the chosen model (or the evals SDK default), and say the model calls, the time, and the file that the run writes before asking whether to proceed. The generator does not inherit the chat provider, endpoint, credentials, or model. Never copy the chat model name into generation settings merely because it is available in chat. If the developer requests the same non-Bedrock chat model, explain that this integration does not support that connection; do not silently substitute a provider. Include a relevant assumption if needed, not a dump of all settings. If the developer has already approved this specific proposal, proceed without asking again. Never start a paid run based only on opening Create a new experiment.

## Generate and hand back control

After approval, call strands_dev_create_experiment with the settings. Generation uses ExperimentGenerator from strands-evals and saves tmp/experiments/<name>.json in the workspace folder. Progress appears below the chat input.

When it finishes, give the name and case count, show a few representative inputs, and point to /experiment for review. Offer to run the cases, but do not start /test or /optimize without approval. If it fails, explain the actionable problem briefly and offer a targeted fix rather than restarting the interview.

Tool settings reference (use silently unless asked):
- task: required, the specific behavior being tested; context: relevant scenarios or constraints.
- cases: 1–50, default 10; topics: 0 disables grouping.
- evaluators: use strands_dev_evaluators for names and required settings.
- expectedOutput: default on; expectedTrajectory, expectedInteractions, metadata: default off.
- model: explicitly selected Bedrock model or the evals Python SDK default, never inferred from the chat model; parallel: 1–10, default 4.
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
    `Bedrock generator model ${settings.model || 'the evals Python SDK default'}`,
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
