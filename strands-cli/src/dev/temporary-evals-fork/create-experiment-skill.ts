import type { AgentExtensionSkill } from '../../agent/extension.js'
import type { GenerationError, GenerationSettings } from '../panels/model.js'

export const TEMPORARY_CREATE_EXPERIMENT_SKILL = 'create-experiment'

const INSTRUCTIONS = `# Create an experiment

An experiment is a set of test cases for this agent. ExperimentGenerator from strands-evals writes the cases, and strands dev saves them in tmp/experiments/<name>.json in the workspace folder. /test and /optimize run the agent on an experiment.

## 1. Collect the settings

Call strands_dev_status first. It gives the suggested settings for a new experiment and the names that are taken.

Talk with the developer to fill in the settings. Ask about one or two settings in each message. Offer the suggested value, and use it when the developer has no preference. Do not ask about a setting that has a good default unless the developer wants to change it.

- task (required): what the agent does in the cases, for example "Answer refund questions for an online store". Suggest the task from strands_dev_status.
- context: the scenarios, users, edge cases, or failure modes the cases must cover. Ask what the developer worries about. This is the most useful setting, so always ask about it.
- cases: how many cases, from 1 to 50. Default 10.
- topics: how many topic groups spread the cases over different areas. 0 turns topics off. Use 3 to 5 for an agent with a broad task.
- evaluators: how each case is scored. Call strands_dev_evaluators for the list, with a description of each. Recommend one or two that fit the task, and explain why in one sentence. Some evaluators need settings, for example the tool name for ToolCalled. Ask for each required setting.
- expectedOutput (default on), expectedTrajectory (the tools the agent must call, default off), expectedInteractions (default off), metadata (default off): what the generator writes into each case. Turn on expectedTrajectory when an evaluator scores tool use.
- model: the Bedrock model ID that writes the cases. Default: the suggested model, or the strands default when there is none.
- parallel: how many cases are written at once, from 1 to 10. Default 4. Lower it when Bedrock throttles.
- name: letters, numbers, dots, dashes, and underscores, for example refunds-v1. Suggest a name from the task. It must not be taken.

## 2. Confirm

Show the settings as a short list and ask the developer to confirm. Generation calls a model for each case, so do not start it before the developer says yes.

## 3. Generate

After the developer confirms, call strands_dev_create_experiment with the settings. It takes one to several minutes. Progress shows below the chat input.

When it finishes, tell the developer the experiment name, the number of cases, and the file path, and show three or four case inputs. Then offer the next steps: review or edit the cases with /experiment, or run them now (strands_dev_test).

If it fails, say why in one sentence, give the fix that the error suggests, and offer to try again with changed settings.`

export const temporaryCreateExperimentSkill = (): AgentExtensionSkill => ({
  name: TEMPORARY_CREATE_EXPERIMENT_SKILL,
  description:
    'Walk the developer through creating a strands dev experiment (generated test cases for this agent), confirm the settings, then generate it with strands_dev_create_experiment.',
  instructions: INSTRUCTIONS,
})

const settingsSummary = (settings: GenerationSettings): string =>
  [
    `task "${settings.task}"`,
    ...(settings.context.trim() ? [`context "${settings.context.trim()}"`] : []),
    `${settings.cases} cases`,
    ...(settings.topics > 0 ? [`${settings.topics} topics`] : []),
    `evaluators ${settings.evaluators.map(({ name }) => name).join(' and ')}`,
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
