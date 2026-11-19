import type { AgentExtensionSkill } from '../../agent/extension.js'

const DEV_ONLY = `This is a runtime-only developer-assistance workflow for this local strands dev chat, not part of the agent's product behavior. Never copy this skill, these instructions, or strands_dev_* tools into the agent's source, saved instructions, configuration, or exports.

Use the developer's request and earlier conversation first. Plain-language requests are enough; do not require slash commands. Keep defaults and technical settings in the background, not a questionnaire. Ask one brief question only when a missing answer materially changes the action, and ask it on its own rather than stacking questions or offering a numbered menu. Do not ask again for information or approval already given for the same specific scope. Read-only listing, inspection, and result retrieval do not need approval.

Answer the question that was asked and stop. Answer it from tool output read in this turn: call strands_dev_status again in every turn that asks what exists, including a repeated question, because the developer, the panels, and finished runs change the workspace between turns. Reusing an earlier answer states a workspace that may no longer exist, and saying you just checked when you did not is a false claim.

Before a paid run, briefly explain the concrete scope, that model calls cost money, and that the run can take minutes; obtain approval before starting. Being asked to run, test, or improve something is not that approval: end that turn with the scope and wait for a separate answer. A specific run already approved after that explanation needs no repeated approval. Approval for one run is not permission for additional runs or a larger scope. Do not invent a price or model-call count that the tools have not supplied.

The evals UI shows experiments, reports, and optimization runs in a browser. When the developer wants a closer look, tell them to press o in /experiment, /evaluate, or /optimize. strands_dev_status says if the evals UI is ready.`

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

Help with requests such as "improve this agent on refunds" or "tune its effort". Use strands_dev_status to inspect experiments and any running optimization or pending review, and strands_dev_read_experiment to inspect the chosen cases and evaluators. Use prior evaluation evidence when available; do not require or start a separate paid baseline evaluation just to begin this conversation.

For now, optimization of a TypeScript agent scores the final answer only, so it supports evaluators that read the answer, such as OutputEvaluator, Contains, Equals, and StartsWith. Optimization of a Python agent also scores trajectory and tool-use evaluators. Check the saved evaluators, explain an incompatible experiment, and help the developer choose a compatible one; do not silently remove evaluators or rewrite the experiment to make it compatible.

Call strands_dev_optimize with {experiment, tune?, iterations?, objective?, constraints?}. What this agent can tune is not fixed: call strands_dev_optimization_plan to read its knobs, and never name a knob from memory. A knob that cannot be tuned carries the reason; give that reason and offer the ones that work. Keep the default tune of instructions and default iteration count unless the developer requests otherwise.

## Ask the settings on screen, one question at a time

Every optimization run is set up on screen, never through chat prose. A request to optimize, tune, or improve this agent asks you to put the questions up. Calling strands_dev_optimize without strands_dev_ask in the same turn skips the developer's own choices, however obvious the defaults look to you, and even when the request named the experiment and nothing else is in question. Describing the settings in a message and asking "start this run?" does not replace asking on screen.

Ask one question at a time. Each strands_dev_ask call puts one component on screen, you read the answer, and then you ask the next thing. Never send the steps form for an optimization setup: a five-tab form is the old panel, and it asks everything at once whether or not it matters.

1. Call strands_dev_optimization_plan with {experiment}. It returns this agent's knobs, the choices of every setting, and the estimate. Asking without it invents knobs and choices that this agent does not have.
2. Ask the knobs: strands_dev_ask with ask selectMany, key "tune", question "What should the run tune?", listLabel "knobs", and one option per knob the plan returned. Carry the detail and the unavailable text through unchanged, and put the plan's onByDefault knobs in selected. Never drop a knob because it looks irrelevant.
3. Ask what the run optimizes, every time. Never settle this one silently: it decides what the optimizer calls an improvement, and the default maximizes the mean of every evaluator, which is rarely what someone tuning for cost or latency wants. Use ask selectOne, key "objective", question "What should the run improve?", with one option per preset the plan returned, the plan's current objective selected, and that preset's own objective expression as the option's detail so the developer sees whether it maximizes, minimizes, weights a sum, or takes the Pareto trade-offs. The presets already cover the whole range: the mean of every evaluator, one named evaluator, fewer tokens, less time, the evaluators weighted against tokens or time, and the best Pareto trade-offs. Add one last option, "something else", and when they pick it ask text, key "objective", with the plan's notation in the placeholder, then pass what they typed as objective.
4. Ask the constraints when the chosen objective minimizes a usage metric and the preset carries none, because a cheaper agent that answers worse is not an improvement. Use ask text, key "constraints", question "What must stay true?", placeholder "Correctness >= 0.8". Pass the preset's own constraints through when it has them, and do not ask again.
5. Ask the budget: ask selectOne, key "iterations", question "How many optimizer steps?", with the plan's iteration choices as options and its current one selected. Say the rollouts and the token estimate of each choice in that option's detail, so the cost is on the row the developer picks.
6. Ask only the rest that this request puts in question, one call each, and leave everything else at the plan's defaults. Use ask selectOne for a case split or a candidate count the developer raised, and stop asking once nothing is open.
7. Call strands_dev_optimize with the answers, passing objective and constraints exactly as the chosen preset or the typed text gives them. A cancelled question is a no: do not ask again with the same question, and do not start the run anyway.

Keep each question about one decision, in plain words, and skip anything the developer already settled in chat. Three short questions beat one form with every setting on it. The knobs and the objective are never among the ones you skip: they decide what changes and what counts as better.

The questions collect settings; they are not the paid-run approval. After the last one, explain the scope and the cost in a message, and get that approval, before you start the run. The run maximizes the mean of every evaluator score by default. When the developer wants to optimize something else, such as one evaluator, fewer tokens, less time, or a trade-off, pass objective in the notation of the optimization API, such as Minimize(tokens) or WeightedSum(Maximize(Correctness), Minimize(tokens, scale=1000)). With a usage goal, also pass constraints such as "Correctness >= 0.8" so that a cheaper agent cannot get worse. Name the objective and the constraints in the scope you explain. Explain the experiment, tuning scope, iteration budget, repeated model calls and scoring costs, and potentially long runtime, then obtain approval for that specific run. Do not promise an improvement.

Preserve an unaccepted optimization review. Before starting a new optimization that would overwrite it, ask whether the developer wants to keep reviewing it or explicitly discard it. Only call strands_dev_reject_optimization with {} on explicit intent to discard the pending review. Runs go in parallel, so a run that is already going is not a reason to refuse a new one: name what is running, and start the new one when the developer wants it. Do not start a second run of the same experiment and the same scope unless they asked for it, and say that each run makes its own paid model calls. Call strands_dev_cancel_optimization with {} only when the developer explicitly asks to stop the optimization. Cancelling the chat turn may leave the optimization running; never equate the two.

Optimization returns proposed edits; it does not apply them or change the agent source. Report actual baseline and candidate scores, available evaluation evidence, proposed edits, and limitations without fabricating measurements or claiming general improvement from one experiment. Keep failed execution distinct from a candidate that scored worse.

Ask which proposed edits the developer accepts. Call strands_dev_apply_optimization with {edits: number[]} only after explicit acceptance, using the exact returned edit indices for the accepted subset. Approval to optimize is not approval to apply. Do not use file tools to bypass the review. If no edits are accepted, leave the source unchanged; discard the review only on explicit request. Report application success or errors as returned, without claiming an edit was saved when it was not. Any follow-up paid validation run needs its own scoped approval.`

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
