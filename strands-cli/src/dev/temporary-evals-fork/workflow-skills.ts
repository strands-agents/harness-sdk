import type { AgentExtensionSkill } from '../../agent/extension.js'

const DEV_ONLY = `This is a runtime-only developer-assistance workflow for this local strands dev chat, not part of the agent's product behavior. Never copy this skill, these instructions, or strands_dev_* tools into the agent's source, saved instructions, configuration, or exports.

Use the developer's request and earlier conversation first. Plain-language requests are enough; do not require slash commands. Keep defaults and technical settings in the background, not a questionnaire. Ask one brief question only when a missing answer materially changes the action, and ask it on its own rather than stacking questions or offering a numbered menu. Do not ask again for information or approval already given for the same specific scope. Read-only listing, inspection, and result retrieval do not need approval.

Answer the question that was asked and stop. Answer it from tool output read in this turn: call strands_dev_status again in every turn that asks what exists, including a repeated question, because the developer, the panels, and finished runs change the workspace between turns. Reusing an earlier answer states a workspace that may no longer exist, and saying you just checked when you did not is a false claim.

Before a paid run, briefly explain the concrete scope, that model calls cost money, and that the run can take minutes; obtain approval before starting. Being asked to run, test, or improve something is not that approval: end that turn with the scope and wait for a separate answer. A specific run already approved after that explanation needs no repeated approval. Approval for one run is not permission for additional runs or a larger scope. Do not invent a price or model-call count that the tools have not supplied.

The evals UI shows experiments, reports, and optimization runs in a browser. When the developer wants a closer look, tell them to press o in /experiment or /evaluate. strands_dev_status says if the evals UI is ready.`

const MANAGE_EXPERIMENTS = `# Manage experiments in dev chat

${DEV_ONLY}

Help with requests such as "what experiments do I have?", "show the refund cases", or "how is this scored?" using conversation rather than sending the developer to a panel.

Always call strands_dev_status afresh before listing saved experiments or claiming none exist; earlier chat messages and prior tool output may be stale. Then list saved experiments and their last results. Use strands_dev_read_experiment with {experiment, offset?, limit?} to read saved cases and evaluator details; page through the returned data when needed rather than claiming a partial page is the whole experiment. Explain actual inputs, expected outputs, and scoring rules, distinguishing saved expectations from observed agent answers. Use strands_dev_evaluators when the developer needs the available evaluator catalog or setting details. The first evaluator lookup can take a minute while the environment is prepared.

For new cases or a new experiment, use the existing create-experiment skill and strands_dev_create_experiment; do not replace its goal-shaping and generation approval workflow. Listing or reading an experiment must not trigger generation, an evaluation, or optimization.

There is no dedicated experiment-edit or delete tool here. Edit saved experiment files with existing file tools only when the developer requests edits, first reading the file and keeping unrelated cases and evaluators intact. Do not automatically delete experiments. If the developer wants to run or tune an experiment, use run-evaluations or optimize-harness guidance and obtain any needed paid-run approval.`

const RUN_EVALUATIONS = `# Run evaluations and inspect results in dev chat

${DEV_ONLY}

Help with requests such as "evaluate refunds", "test refunds", "run these experiments", "rerun the failures", or "show the latest results". Resolve experiment names from the conversation and strands_dev_status; if the selection is ambiguous, ask only for the missing scope. Read cases and evaluator details with strands_dev_read_experiment when needed to explain the run.

Evaluations exercise the current authored agent through its SDK-configured runtime, not a separate generator provider or the chat assistant. An evaluation leaves the agent source unchanged. Explain which experiments and cases will run and that scoring may also call models before obtaining paid-run approval. "Run my tests" and "check my agent against my examples" ask for that explanation, not for the run: name the experiments and case counts, then end the turn. Use existing defaults rather than asking the developer to configure a generator model.

Call strands_dev_evaluate with {experiment, failedOnly?} for one experiment, or {experiments: string[], failedOnly?} for a batch. Use one selector, not both. Set failedOnly only when the developer requests it and prior failures exist in a finished run for each selected experiment; check strands_dev_evaluation_results first. If there are no prior failures, explain that and ask before substituting a paid full run. Do not silently expand a failed-only request to all cases.

Never infer that an experiment or result is missing from earlier conversation. Always call strands_dev_evaluation_results with {experiment, offset?, limit?}; it reads status and case results without rerunning anything. Use strands_dev_status for an overview and page through case results as needed. A request to inspect results is not permission to rerun evaluations. An evaluation may continue after the developer cancels the chat turn. Do not claim that cancelling a turn stopped the evaluation or promise an evaluation-cancellation tool.

Report actual evidence from the tools: status, completed case counts, pass/fail outcomes, scores and evaluator feedback when present. Distinguish queued, running, failed execution, and completed results. Do not fabricate results, infer success from a started job, or present a partial page as the complete run. Summarize representative failures with their inputs, expected outputs, actual answers, and feedback only when returned. A failing case is evidence to discuss, not permission to change source, regenerate cases, optimize, or start another paid run.`

const OPTIMIZE_HARNESS = `# Optimize the harness in dev chat

${DEV_ONLY}

Help with requests such as "improve this agent on refunds" or "tune its effort".

## The optimize skill of strands-evals is the logic

strands-evals ships an \`optimize\` skill, and it owns how an optimization works: how to read the request, which questions to ask and in what order, the objective notation and its metrics, the constraints, the budget, the review summary it confirms before the run, how the run executes, and how to read the report it writes. Follow it. Do not re-derive any of that here, and do not contradict it.

This skill holds only what strands dev does differently, and the rules below that the chat itself needs.

## What strands dev does differently

- Experiments live in this workspace, at \`strands-dev/experiments/<name>/<name>.json\`. Find them with strands_dev_status rather than by reading the folder, because a panel or a finished run can change them between turns. With none saved, say so and offer to create one with the create-experiment skill instead of pointing at a folder.
- Runs are saved in this workspace too, at \`strands-dev/experiments/<name>/optimizations/<stamp>/\`. That is the folder the optimize skill expects, and it is already out of git.
- Ask the questions on screen with strands_dev_ask, one component per question, instead of the numbered lists in chat that the optimize skill describes. Keep its order, its defaults, and its wording; only the way the question is put changes. Read strands_dev_optimization_plan first, so the knobs and the choices you offer are this agent's own.
- Start the run with strands_dev_optimize, not by running \`strands-evals optimize\` yourself. It uses this CLI's evals bridge, which is what the optimize skill says to use, and it reports progress below the chat input.

## Rules the chat adds

Runs go in parallel, so a run that is already going is not a reason to refuse a new one: name what is running, and start the new one when the developer wants it. Do not start a second run of the same experiment and the same scope unless they asked for it, and say that each run makes its own paid model calls.

Preserve an unaccepted optimization review. Before starting a new optimization that would overwrite it, ask whether the developer wants to keep reviewing it or explicitly discard it. Only call strands_dev_reject_optimization with {} on explicit intent to discard the pending review. Call strands_dev_cancel_optimization with {} only when the developer explicitly asks to stop the optimization. Cancelling the chat turn may leave the optimization running; never equate the two.

Optimization returns proposed edits; it does not apply them or change the agent source. Report actual baseline and candidate scores, available evaluation evidence, proposed edits, and limitations without fabricating measurements or claiming general improvement from one experiment. Keep failed execution distinct from a candidate that scored worse. Do not promise an improvement.

Ask which proposed edits the developer accepts. Call strands_dev_apply_optimization with {edits: number[]} only after explicit acceptance, using the exact returned edit indices for the accepted subset. Approval to optimize is not approval to apply. Do not use file tools to bypass the review. If no edits are accepted, leave the source unchanged; discard the review only on explicit request. Report application success or errors as returned, without claiming an edit was saved when it was not. Any follow-up paid validation run needs its own scoped approval.

For now, optimization of a TypeScript agent scores the final answer only, so it supports evaluators that read the answer, such as OutputEvaluator, Contains, Equals, and StartsWith. Optimization of a Python agent also scores trajectory and tool-use evaluators. Check the saved evaluators, explain an incompatible experiment, and help the developer choose a compatible one; do not silently remove evaluators or rewrite the experiment to make it compatible.`

/** Runtime-only guidance, separate from the existing create-experiment skill. */
export const temporaryWorkflowSkills = (): AgentExtensionSkill[] => [
  {
    name: 'manage-experiments',
    description:
      'List and inspect saved experiments, their cases, and their scoring in dev chat. ' +
      'Use it when the developer asks what exists or what a case holds, in any wording, including ' +
      '"what experiments do I have", "what tests are saved", "show me my cases", "show the refund cases", ' +
      '"what does this experiment check", and "how is this scored". Not part of the exported agent.',
    instructions: MANAGE_EXPERIMENTS,
  },
  {
    name: 'run-evaluations',
    description:
      'Run approved evaluations, or inspect the progress and case results of evaluations already run, in dev chat. ' +
      'Use it when the developer asks to try the agent on saved cases or asks how a run went, in any wording, including ' +
      '"run my tests", "evaluate my agent", "check my agent against my examples", "test refunds", "try these cases", ' +
      '"did my last test pass", "how did the run go", and "rerun the failures". Not part of the exported agent.',
    instructions: RUN_EVALUATIONS,
  },
  {
    name: 'optimize-harness',
    description:
      'Guide the developer through setting up an optimization run, then propose edits that raise the score of this ' +
      'agent and write only the edits they accept, in dev chat. Use it when the developer asks to make the agent ' +
      'better or to set up a run, in any wording, including "can you make my agent better at this", ' +
      '"improve this agent on refunds", "how do I fix these failures", "tune its effort", "optimize", and ' +
      '"make it smarter". Not part of the exported agent.',
    instructions: OPTIMIZE_HARNESS,
  },
]
