import type { AgentExtensionSkill } from '../../agent/extension.js'
import { TEMPORARY_OPTIMIZE_SKILL } from './optimize-skill.js'

const DEV_ONLY = `This is a runtime-only developer-assistance workflow for this local strands dev chat, not part of the agent's product behavior. Never copy this skill, these instructions, or strands_dev_* tools into the agent's source, saved instructions, configuration, or exports.

Use the developer's request and earlier conversation first. Plain-language requests are enough; do not require slash commands. Keep defaults and technical settings in the background, not a questionnaire. Ask one brief question only when a missing answer materially changes the action, and ask it on its own rather than stacking questions or offering a numbered menu. Do not ask again for information or approval already given for the same specific scope. Read-only listing, inspection, and result retrieval do not need approval.

Answer the question that was asked and stop. Answer it from tool output read in this turn: call strands_dev_status again in every turn that asks what exists, including a repeated question, because the developer, the panels, and finished runs change the workspace between turns. Reusing an earlier answer states a workspace that may no longer exist, and saying you just checked when you did not is a false claim.

Before a paid run, briefly explain the concrete scope, that model calls cost money, and that the run can take minutes; obtain approval before starting. Being asked to run, test, or improve something is not that approval: end that turn with the scope and wait for a separate answer. A specific run already approved after that explanation needs no repeated approval. Approval for one run is not permission for additional runs or a larger scope. Do not invent a price or model-call count that the tools have not supplied.

The evals UI shows experiments, reports, and optimization runs in a browser on the developer's own machine. strands_dev_status carries its links: evalsUi.evaluationRuns and evalsUi.optimizationRuns for the lists, a page on each experiment, and a page on each optimization run. Give the developer the one link that matches what you are talking about, as a plain link in your message, and leave opening it to them. Never open a browser for them, never offer the list when you have the page of the thing itself, and never write an address that strands_dev_status did not give you. With evalsUi.status not ready, say the UI is still starting rather than guessing a link.`

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

const OPTIMIZE_DEV_RULES = `# Optimize the harness in dev chat

${DEV_ONLY}

The optimize skill of strands-evals follows. It is the workflow: what to ask, in what order, the objective notation, the budget, the review it confirms, the run, and the report. Follow it, and do not re-derive or contradict it.

These rules replace the matching parts of it, because strands dev already owns the workspace:

- Workspace: this chat is the strands-workspace the skill asks for. Do not ask for a workspace path, and do not run its scripts/prepare.mjs or \`strands-evals optimize\` yourself. strands dev does that work through its own tools.
- Step 1, the inputs: call strands_dev_status for the saved experiments and strands_dev_optimization_plan for the chosen one, instead of the skill's inspect step. The plan returns this agent's knobs with the reason each unavailable one cannot be tuned, the choices of every setting, the objective presets with their expressions, and the rollout and token estimate. Never name a knob or a choice from memory.
- Experiments: they live at strands-dev/experiments/<name>/<name>.json, which is where the skill expects them. With none saved, offer to create one with the create-experiment skill rather than pointing at a folder.
- Runs: they are saved at strands-dev/experiments/<name>/optimizations/<stamp>/, the folder the skill names, and it is already out of git.
- Questions: strands dev has an on-screen question UI, so take the skill's own advice and use it. Put each question up with strands_dev_ask, one component per question: selectMany for the knobs, selectOne for a single choice, text where the skill takes a free-form reply. Keep the skill's order, defaults and wording, and skip its numbered chat lists. Esc declines, so never add a decline option of your own, and a cancelled question is a no.
- A list needs a real choice: selectOne takes two options or more. With one, there is nothing to pick, so say the value instead of asking, or use confirm.
- A text question starts empty. Put the example reply in its placeholder and the current values in the step's footnote, so a blank answer keeps them. Never prefill the field with a summary of the defaults: the developer would have to retype all of it to change one number. The budget step is the one this matters most for, because the skill takes all five settings in one reply.
- Running: start the run with strands_dev_optimize once the review is confirmed. Its progress shows below the chat input, and runs go in parallel: a run already going is not a reason to refuse a new one. Name what is running, and do not start a second run of the same experiment and scope unless asked.
- Links: give the developer this run's own page, the one on its entry in strands_dev_status, at three points: when the run starts so they can watch it, when it finishes next to your summary, and whenever they ask how it went. One link per message, the page of that run and not the list of runs.
- Report and edits: strands_dev_optimize returns the proposed edits. Apply only the ones the developer names, with strands_dev_apply_optimization, and never write them with file tools. Preserve an unaccepted review: before a run that would overwrite one, ask whether to keep reviewing it, and call strands_dev_reject_optimization only on explicit intent to discard. Call strands_dev_cancel_optimization only when the developer asks to stop a run.
- Evaluators: optimization of a TypeScript agent scores the final answer only, so it supports evaluators that read the answer, such as OutputEvaluator, Contains, Equals, and StartsWith. A Python agent also scores trajectory and tool-use evaluators. Explain an incompatible experiment and help pick a compatible one; never silently remove an evaluator or rewrite the experiment.

Do not promise an improvement.`

const OPTIMIZE_HARNESS = `${OPTIMIZE_DEV_RULES}

---

${TEMPORARY_OPTIMIZE_SKILL}`

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
