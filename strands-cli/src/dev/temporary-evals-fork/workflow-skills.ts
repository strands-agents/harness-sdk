import type { AgentExtensionInlineSkill } from '../../agent/extension.js'

const DEV = `This chat runs in strands dev. Follow the active skill; only these points are specific to strands dev.

Each experiment is strands-dev/experiments/<name>/<name>.json, with its runs and optimizations in the same folder. The evals UI shows and edits them in a browser: strands_dev_open_evals_ui opens one. Whenever the skill asks the developer to choose or type something, ask it with the strands_dev_ UI tools, one question per call, not as a numbered list in chat. A cancelled question is a no. Run every strands-evals command through the background-evals skill, never from a shell.

A command that calls models costs money: name its scope in chat and end the turn, and start it only when the developer approves in a later turn.`

const EXPERIMENT_COMMAND = `# /experiment

The developer typed /experiment, and the strands-evals skill is active. ${DEV}

Ask which experiment with strands_dev_single_select, with exactly these rows: one per saved experiment from strands_dev_status (the name as label, the case count as detail), then a last row "Create a new experiment" with the value new. Offer no other rows. With no saved experiment, skip the question and create a new one.

For a saved experiment, call strands_dev_open_file to open it in the editor of the developer, do not print the file in chat, and ask what to change. When it cannot open, give the file path, offer strands_dev_open_evals_ui, and ask in chat what to change.

For "Create a new experiment", ask the task straight away with strands_dev_text_input, question "What should this experiment test? Or say past chats to build the cases from them." Do not ask first how to build it. When the answer asks for past chats or traces, call strands_dev_session_converter and follow the skill it returns. The task, or the choice of past chats, is the only thing to ask. Do not ask about the number of cases, evaluators, the model, or other settings, even where the skill lists them: strands dev picks them. Name the experiment after what it tests, in a few lowercase words joined by dashes (for example refund-policy), not one already saved. Pass the task as --task-description, and say the name and the case count from strands_dev_status newExperiment in the approval message.`

const EVALUATE_COMMAND = `# /evaluate

The developer typed /evaluate, and the strands-evals skill is active. ${DEV}

Ask which experiments to run with strands_dev_multi_select, one row per saved experiment from strands_dev_status (the case count as detail), with the question "Which experiments should run? Each run makes paid model calls." Picking them is the approval: start each picked experiment at once with strands_dev_run_background run, without asking again in chat, then say in one line what started. A cancelled question starts nothing.`

const OPTIMIZE_COMMAND = `# /optimize

The developer typed /optimize, and the optimize skill is active. ${DEV}

When the skill asks which experiment to use, call strands_dev_single_select with the question "Which experiment should the run tune?" and one row per saved experiment from strands_dev_status (the name as label, the case count as detail). Do not name experiments in the question or list them in chat; the rows show every one.

strands_dev_optimization_plan gives the knobs this agent can tune, the case split, and the budget; use them instead of reading the agent file. Offer exactly the knobs it returns, no others, even where the skill lists more. A list knob such as tools or MCP servers turns each entry on or off; pass --tune KEY for each one picked, such as --tune tools. A knob with notInCall is an option the call leaves out: the run starts it from the strands-harness default, and applying its edit writes the option into the call, so say that in the review. In the constraints question, leave out the skill's list of what can be constrained: no parenthetical of metrics in the question or the rows. Ask the budget in one strands_dev_number_input, one field per setting (steps, candidates, runs, finalists, trials at once), each with the plan's value and min. Any whole number from the min works; the estimate says when the total passes the rollout cap.

Print the review in chat in the skill's own format and end the turn; the developer's reply approves it or changes a row. After the run, apply the edits the developer accepts with strands_dev_apply_optimization.`

const BACKGROUND_EVALS = `# Run strands-evals in the background

strands dev runs strands-evals commands for you with strands_dev_run_background, in its prepared evals environment and with the agent of this workspace. Pass the command (run, optimize run, or generate), the experiment name, and the flags the skill would pass in args; leave out --agent, the experiment file, and the output paths, which strands dev sets. Each run starts at once, shows its progress on a line below the chat input, writes run.log under strands-dev/experiments/<name>/, and posts a notice when it finishes. A run that stopped when strands dev closed continues by itself at the next start, so there is no resume command.

Read the results with strands_dev_status and strands_dev_evaluation_results. Stop a run with strands_dev_stop_background only when the developer asks; cancelling the chat turn leaves it running. List the evaluators with strands_dev_evaluators.`

/** Runtime-only guidance that the skill commands and plain requests share. */
export const temporaryWorkflowSkills = (): AgentExtensionInlineSkill[] => [
  {
    name: 'background-evals',
    description:
      'Run strands-evals commands (run, optimize run, generate) in the background inside strands dev, with ' +
      'progress below the chat input. Use it whenever the strands-evals or optimize skill says to run a ' +
      'strands-evals command. Not part of the exported agent.',
    instructions: BACKGROUND_EVALS,
  },
]

/** The text that each skill command sends with its skill. */
export const temporaryCommandWorkflows = {
  experiment: EXPERIMENT_COMMAND,
  evaluate: EVALUATE_COMMAND,
  optimize: OPTIMIZE_COMMAND,
} as const
