import type { AgentExtensionInlineSkill } from '../../../agent/extension.js'

const DEV = `This chat runs in strands dev. Follow the active skill; only these points are specific to strands dev.

Each experiment is strands-dev/experiments/<name>/<name>.json, with its runs and optimizations in the same folder. The evals UI shows and edits them in a browser: strands_dev_open_evals_ui opens one. Whenever the skill asks the developer to choose something or to enter numbers, ask it with the strands_dev_ UI tools, one question per call, not as a numbered list in chat. Ask a free-form question on its own in chat. A cancelled question is a no. Run every strands-evals command through the background-evals skill, never from a shell.

A command that calls models costs money: name its scope in chat and end the turn, and start it only when the developer approves in a later turn. When strands_dev_status gives fileChanges, say it in each question or message that asks the developer to approve an evaluation or an optimization.`

const EXPERIMENT_COMMAND = `# /experiment

The developer typed /experiment, and the strands-evals skill is active. ${DEV}

Ask which experiment with strands_dev_single_select, with exactly these rows: one per saved experiment from strands_dev_status (the name as label; as detail the case count, and when its lastTest is done, also its passed and total, such as "5 cases · 4 of 5 passed"), then "Run several experiments" with the value several when two or more are saved, then a last row "Create a new experiment" with the value new. Offer no other rows. With no saved experiment, skip the question and create a new one. For "Run several experiments", ask which ones with strands_dev_multi_select, one row per saved experiment with its case count, and the question "Which experiments should run? Each run makes paid model calls." Picking them is the approval: start each at once with strands_dev_run_background run, then say in one line what started. A cancelled question starts nothing.

For a saved experiment, ask what to do with it in a second strands_dev_single_select, with the question "What do you want to do with <name>?" and these rows, leaving out a row whose condition does not hold:
- "View its last report" (value report) as the first row when its lastTest is done, with its passed, total, and score as detail.
- "Run it again" (value run) when its lastTest is done, otherwise "Run it", with its case count and "makes paid model calls" as detail. Leave it out while its lastTest is running, and say in the question that it is running, with its done and cases.
- "Edit its cases" (value edit).
When strands_dev_status gives fileChanges, add it to this question and to the question of "Run several experiments". Picking Run is the approval: start it at once with strands_dev_run_background run, without asking again in chat, then say in one line what started; its progress shows on a line below the chat input. For the report, read it with strands_dev_evaluation_results, give the passed, total, and score in one line, then each failed case in one line with the reason its evaluator gave, and offer strands_dev_open_evals_ui with the report view for the whole of it; do not print the report file. For Edit, call strands_dev_open_file to open it in the editor of the developer, do not print the file in chat, and ask what to change. When it cannot open, give the file path, offer strands_dev_open_evals_ui, and ask in chat what to change.

For "Create a new experiment", ask the task straight away in chat: "What should this experiment test? Or say past chats to build the cases from them." Do not ask first how to build it. When the answer asks for past chats or traces, call strands_dev_session_converter and follow the skill it returns. The task, or the choice of past chats, is the only thing to ask. Do not ask about the number of cases, evaluators, the model, or other settings, even where the skill lists them: strands dev picks them. Name the experiment after what it tests, in a few lowercase words joined by dashes (for example refund-policy), not one already saved. Pass the task as --task-description, and say the name and the case count from strands_dev_status newExperiment in the approval message. When the cases are saved, offer to run them.`

const OPTIMIZE_COMMAND = `# /optimize

The developer typed /optimize, and the optimize skill is active. ${DEV}

When the skill asks which experiment to use, call strands_dev_single_select with the question "Which experiment should the run tune?" and one row per saved experiment from strands_dev_status (the name as label, the case count as detail). Do not name experiments in the question or list them in chat; the rows show every one.

strands_dev_optimization_plan gives the knobs this agent can tune, the case split, and the budget; use them instead of reading the agent file. Offer exactly the knobs it returns, no others, even where the skill lists more. A list knob such as tools or MCP servers turns each entry on or off; pass --tune KEY for each one picked, such as --tune tools. A knob with notInCall is an option the call leaves out: the run starts it from the strands-harness default, and applying its edit writes the option into the call, so say that in the review. In the constraints question, leave out the skill's list of what can be constrained: no parenthetical of metrics in the question or the rows. Ask the budget in one strands_dev_number_input, one field per setting (steps, candidates, runs, finalists, trials at once), each with the plan's value and min. Any whole number from the min works; the estimate says when the total passes the rollout cap.

Print the review in chat in the skill's own format and end the turn; the developer's reply approves it or changes a row. When strands_dev_optimization_plan returns autoAccept, say in the review that the edits will be applied without a diff. When the run finishes, its edits appear on the developer's screen as a diff, and they apply or leave each one there; an applied edit is written and hot-reloaded without you. Report the run in a line or two, the score before and after, and do not print the edit text or ask which edits to apply, even where the skill says to apply the best version when asked. A diff closed without an answer keeps waiting on its line below the chat input; strands_dev_review_optimization puts it back on screen. Call strands_dev_apply_optimization only for edits the developer names in chat. Read a run through strands_dev_status, never the files of its run folder such as best.diff or best.values.json, and do not write the skill's named copy of the experiment: strands dev names every case. Skip the skill's "Resuming a run" section: strands dev continues a stopped run itself. Where the skill says a TypeScript agent's steps are traced, they are not here: strands dev runs a TypeScript agent in its own runner, which records the answer and the token usage but no trace, so an evaluator that reads the trace cannot score it. Explain an incompatible experiment instead of removing its evaluators.`

const BACKGROUND_EVALS = `# Run strands-evals in the background

strands dev runs strands-evals commands for you with strands_dev_run_background, in its prepared evals environment and with the agent of this workspace. Pass the command (run, optimize run, or generate), the experiment name, and the flags the skill would pass in args; leave out --agent, the experiment file, and the output paths, which strands dev sets. Each run starts at once, shows its progress on a line below the chat input, writes run.log under strands-dev/experiments/<name>/, and posts a notice when it finishes. A run that stopped when strands dev closed continues by itself at the next start, so there is no resume command.

Read the results with strands_dev_status and strands_dev_evaluation_results. Stop a run with strands_dev_stop_background only when the developer asks; cancelling the chat turn leaves it running.`

/** Runtime-only guidance that the skill commands and plain requests share. */
export const evalsWorkflowSkills = (): AgentExtensionInlineSkill[] => [
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
export const evalsCommandWorkflows = {
  experiment: EXPERIMENT_COMMAND,
  optimize: OPTIMIZE_COMMAND,
} as const
