/**
 * The optimize skill of strands-evals, vendored from strands-agents/evals#645 (workstream/optimizer-workflow 94a6940).
 * It is the workflow for an optimization; strands dev only replaces the parts in workflow-skills.ts.
 * Replace this with a read of the installed strands-evals once the skill lands on its mainline.
 */
export const TEMPORARY_OPTIMIZE_SKILL_VERSION = '0.7.0'

export const TEMPORARY_OPTIMIZE_SKILL = `# optimize

Sets up and runs \`strands-evals optimize run\` on the agent of a \`strands-workspace\`, the same way the Strands CLI runs it: the CLI's evals bridge loads the agent, so the knobs, the optimizer environment, and the run files match the CLI's.

The optimizer is experimental and isn't on evals \`main\` yet; the bridge installs the build the Strands CLI pins.

\`<skill_dir>\` below is the folder holding this file. \`scripts/prepare.mjs\` loads the installed Strands CLI's own modules to find the workspace's agent, read its knobs, prepare the optimizer environment, and write the run files; everything else is the optimizer's own output.

## Steps

Ask every question in plain chat, one step at a time, unless a step says to ask its questions together in one message. Give numbered options with the default one first and marked \`(Default)\`, and end every list except the first question's with a short "Your own" option, so the free-form path is always visible; always accept a free-form answer (ex. "2 steps", "drop effort", "tokens at most 4000"). Check each answer against the rules of its step before moving on; when it breaks one, say which rule and ask again. If you can't wait for a reply (ex. a non-interactive run), take each default, say so, and continue.

The case split, how sure each constraint must be to hold, how crashes count, and how the winner is picked are not asked: they take their defaults and show as review rows (step 6) the user can change.

**What the user sees is plain language.** Options and their descriptions name what changes and what it costs (case counts, rollout estimates), never a flag, a knob key, or a file path. Flags appear only in each step's **Build** notes, which are for you, and in the final command of the review (step 6).

### 1. Find the inputs and ask for a request

From the folder holding \`strands-workspace\` (or pass the workspace path last), run with the \`node\` the Strands CLI uses:

\`\`\`bash
node <skill_dir>/scripts/prepare.mjs inspect [path/to/strands-workspace]
\`\`\`

It prints JSON with:

- \`cli\`: the Strands CLI it found. It resolves \`strands-dev\`, then \`strands\`, on PATH to its package and needs the CLI's evals bridge (\`dist/src/dev/evals-agent\` and the TypeScript runner). When none has it, it exits with code 2: tell the user to install a Strands CLI that includes them, and stop.
- \`agent\`: the agent file, its root folder, and its language. It is \`agent.entrypoint\` of \`strands-workspace/strands-dev/.config\` when that file exists, else \`strands-workspace/agent.py\` or \`strands-workspace/agent.ts\`, which must call \`create_harness(...)\` or \`createHarness(...)\`. A Python agent needs \`strands-harness\` in the workspace's \`.venv\`.
- \`experiments\`: each \`strands-workspace/strands-dev/experiments/<name>/<name>.json\`, with its case count and evaluator names (each \`evaluator_type\` is a metric name).
- \`knobs\`: what step 2 can tune.

Then ask the first question:

\`\`\`text
Describe the optimization you want, or answer "step by step".
1. Step by step (Default): I walk you through the experiment, what may change, the goal, and the budget.
2. Describe it: for example, "make the support agent shorter without losing helpfulness, about 100 rollouts".
\`\`\`

Next, unless the request names one, ask which experiment to use, listing each by name with its cases and evaluators (ex. \`capitals: 6 cases, scored by OutputEvaluator\`), with the one with the most cases as the default, and end with "Your own: the path to another experiment file". With none, tell the user to add an experiment under \`strands-workspace/strands-dev/experiments/\` and stop.

If the user describes it, decide every value of steps 2 to 5 and every review row of step 6 from that text and the files alone, using each default rule where the text says nothing, ask no setup question, and go to step 6. A value the text asks for that breaks a rule is changed to the closest valid one and flagged in the review.

### 2. Knobs: what may change

The user may pick several knobs. If the host has a multi-select question UI, use it, with one entry per knob and the default knobs pre-selected; otherwise show the numbered list below and accept several numbers in one reply. Either way keep the "Your own" entry and the line about memory.

List **every** knob from step 1 that has no \`unavailable\`, by its \`label\`, with its current value and what the optimizer may try (\`detail\`), and a knob's \`note\` in plain words under it. Mark each default knob \`(Default)\`. After the list, always name memory as not tunable with its reason, and name any other untunable knob in the same line when the user might expect to tune it (ex. "system prompt: set in code"). Skills and memory are always in the list \`inspect\` prints.

\`\`\`text
What may the optimizer change? Pick any (ex. "1, 3").
1. instructions (Default): rewritten by the proposer model; now "Answer geography questions in one short sentence."
2. model: try other models next to bedrock/global.anthropic.claude-sonnet-4-5…; name the models to try
3. effort: auto, low, medium, high, xhigh, or max; now auto
4. prompt caching: auto, on, or off; now auto
5. built-in tools: keep or drop each of read
6. background tasks: on or off; now off
7. context manager: auto, agentic, or off; now auto
8. skills: on or off; now on
   (skills can be turned on or off, but their SKILL.md text is not rewritten)
9. built-in plugins: keep or drop each of todos, environment
10. Your own: for example, "only the instructions and effort low or medium"
Not tunable: memory, because every trial runs with memory off, so trials do not share state.
\`\`\`

The kinds behind the labels:

- **text** (instructions, system prompt): rewritten by Reflection, the proposer model.
- **models** (model): a choice of the current model and the model ids the user names. With no other model id it tunes nothing, so ask for the ids when the user picks it.
- **choice** (effort, prompt caching, background tasks, context manager, skills): one of \`choices\`.
- **switches** (built-in tools, tools, MCP servers, built-in plugins, plugins, interventions, or a skills list): each entry in \`entries\` is kept or left out.

Session and memory are off in every trial, whatever the agent sets, so memory is never tunable and setup refuses it. Skills tune as on or off, or as each skill kept or dropped when the agent lists them; the bridge rewrites only text options, so a skill's own text can't be tuned.

**Defaults** are the knobs with \`recommended: true\` in \`inspect\` (the instructions). When the goal or the request is about cost, length, or speed, effort, prompt caching, and the context manager are defaults too when the agent has them. A switch is a default only for entries the cases don't need, and a model choice only with model ids the user named.

**Rules.** At least one knob must be tuned. When a text knob is tuned, warn: Reflection writes shell commands and runs them on this machine with the user's environment, credentials, and network. It is not a sandbox, and text in the cases can carry prompt injection. Run it in a container or VM that has only the credentials the run needs.

**Build.** Each picked knob is one \`--tune <key>\` of the setup command, and each model id to try is one \`--model <id>\`.

### 3. Objective: what to improve

**Metrics** are the experiment's evaluator names (\`Helpfulness\` resolves to \`HelpfulnessEvaluator\`) and the usage metrics tokens, input tokens, output tokens, cache read tokens, cache write tokens, seconds, and model calls. A TypeScript agent runs outside the optimizer's process: it reports usage, but evaluators that read the trace (ex. \`Helpfulness\`, \`TrajectoryEvaluator\`, \`ToolCalled\`) are refused, so pick an experiment whose evaluators read only the answer (ex. \`OutputEvaluator\`).

Ask what to improve. The options hold only objectives; limits come in step 4. When the answer is option 1, 2, 5, or 6, ask its follow-up in one short message: which metric, or which metrics with their weights, each with its default.

\`\`\`text
What should the optimizer improve?
1. Maximize a metric you pick: an evaluator's score, or the mean of every evaluator (Default)
2. Minimize a metric you pick, ex. output tokens, model calls, or seconds
3. Least tokens
4. Less time
5. Best trade-offs between two or more metrics, without weighing them
6. Weighted sum: two or more metrics, each with how much it counts
7. Your own: for example, "fewer output tokens, OutputEvaluator counting twice as much"
\`\`\`

Follow-ups, in plain words:

- **Maximize**: which metric; the default is the mean of every evaluator, or the one evaluator the request names.
- **Minimize**: which usage metric; the default is output tokens when the request is about answer length.
- **Best trade-offs** and **Weighted sum**: which metrics, at least two (ex. "OutputEvaluator and tokens"); for a weighted sum also how much each counts (ex. "OutputEvaluator twice as much as tokens"), and for a tokens or time metric how big a change matters (ex. "1000 tokens", "10 seconds"), with 1000 tokens and 10 seconds as defaults. Say that best trade-offs re-checks at least 5 finalists.

**Default**: option 1 with the mean of every evaluator, unless the request is about length or cost (option 6 with the evaluators and tokens, or output tokens when it's about answer length) or speed (option 6 with the evaluators and seconds).

Objective rules: every metric resolves to an evaluator of the experiment or a usage metric of step 4; a metric appears once; an experiment with no evaluator needs a usage goal (option 2, 3, or 4); options 5 and 6 need 2 metrics or more; a metric name with \`:\` can't be used.

**Build.** Each goal is one \`--objective {maximize,minimize}:METRIC[:weight=X][:scale=X]\`; several goals form a weighted sum.

- Option 1: the mean of every evaluator passes no \`--objective\`; one evaluator is \`--objective maximize:<Evaluator>\`.
- Option 2: \`--objective minimize:<metric>\`.
- Options 3 and 4: \`--objective minimize:tokens\` or \`--objective minimize:seconds\`.
- Option 5: one \`--objective\` per metric (maximize an evaluator, minimize a usage metric) plus \`--pareto\`; under it at least 5 finalists go to validation (step 5).
- Option 6: one \`--objective\` per metric with \`weight=\` from how much it counts.
- Option 7: one \`--objective\` per goal the user names, plus \`--pareto\` when they ask for trade-offs without weighing.

A usage metric in a weighted sum or a Pareto front needs \`scale=\`, the size of a meaningful change: \`scale=100\` on \`output_tokens\` weighs 100 tokens like the whole 0-1 range of an evaluator; default \`scale=1000\` for tokens and \`scale=10\` for seconds. \`weight=\` and \`scale=\` count only when there are several goals.

### 4. Constraints: limits on top of the objective

Ask which constraints to add on top of the objective from step 3, with what can be constrained listed under the options. Name the experiment's own evaluators in the first line of that list. Only a candidate meeting every constraint on validation ships.

\`\`\`text
Which constraints should the winner also meet?
1. None (Default)
2. Every evaluator at least 0.8: OutputEvaluator at least 0.8
3. Your own, for example "OutputEvaluator at least 0.9" or "tokens at most 4000"

A constraint is "at least" or "at most" a number, on the average per run of one case:
- OutputEvaluator: its score, from 0 (worst) to 1 (best)
- tokens: all tokens the agent's model used to answer one case (input plus output)
- input tokens, output tokens: the tokens it read (cached ones included) and the tokens it wrote
- cache read tokens, cache write tokens: input tokens read from or written to the prompt cache
- seconds: how long the agent took to answer one case
- model calls: how many times the agent called its model for one case
The judge's own calls don't count toward tokens, seconds, or model calls.
\`\`\`

An evaluator with its own score range shows that range instead of 0 to 1. A TypeScript agent reports tokens, seconds, and model calls too, but its experiment can't use evaluators that read the agent's steps (ex. Helpfulness, TrajectoryEvaluator, ToolCalled); with one of those, say the experiment needs a Python agent or answer-only evaluators.

When the objective is usage only (step 3: minimize a usage metric, least tokens, or less time), option 2 is the default instead; say why: with nothing but tokens or time to improve, an agent that answers badly, or not at all, can look best, so a minimum score per evaluator keeps the answers good.

Rules: each constraint is one metric from the list above, "at least" or "at most", and a number; a metric name with \`<\`, \`>\`, or \`=\` can't be used.

**Build.** Each constraint is \`--constraint 'METRIC>=X'\` or \`--constraint 'METRIC<=X'\`. How sure each must be to hold is a review row (step 6).

### 5. Budget

Ask all five settings together in one message, each with one line on what it does and its default, then what a rollout is and the estimate for the defaults, worked out with the case counts of the default split (step 6). Take one reply for all of them; a setting the reply leaves out keeps its default, and the user may give their own number for any. Recompute the estimate from the reply and show it the same way before moving on.

\`\`\`text
Budget: change any of these in one reply (ex. "2 steps, 2 runs"); the rest keep their default.
1. Steps: rounds of proposing and testing new versions of the agent. Default 4.
2. Candidates per step: new versions tried in each round. Default 4.
3. Runs of each case: how often each case is repeated per version, to average out noise. Default 1.
4. Finalists: the best versions re-checked on the validation cases to pick the winner. Default 3.
5. Trials at once: how many runs go in parallel; changes speed, not cost. Default 4.

A rollout is one run of the agent on one case; each is judged once per evaluator.
rollouts = runs × (current agent on train + steps × candidates × train
                   + (finalists + current agent) × validation + 2 × test)
         = 1 × (3 + 4 × 4 × 3 + (3 + 1) × 2 + 2 × 1) = 61 rollouts, ~61 judge calls
with 6 cases: 3 train / 2 validation / 1 test.
\`\`\`

Under the best trade-offs objective (step 3, option 5), the finalists default is 5, and test checks every finalist and the current agent, so the last term is \`(finalists + 1) × test\`; say so in the formula line. Judge calls are about rollouts × evaluators, and Reflection's own model calls come on top; neither counts against the budget.

Rules, stated only when an answer breaks one: every setting is a whole number; steps are 0 or more, and 0 measures only the current agent (no new versions, no proposer model); candidates, runs, finalists, and trials at once are at least 1; under best trade-offs, finalists are at least 5. The cap is 500 rollouts, the Strands CLI's: above it, suggest fewer steps, candidates, or runs, or raise the cap if the user asks; the cap must cover the parts outside the steps, \`runs × (train + (finalists + 1) × validation + tested × test)\`, with \`tested\` 2, or \`finalists + 1\` under best trade-offs. When one step's trials, \`candidates × train × runs\`, exceed the trials at once, say that steps then run in batches and take longer.

**Build.** Steps are \`--max-iterations N\`, candidates \`--proposals-per-iteration N\`, runs \`--runs-per-candidate N\`, finalists \`--n-finalists N\` (passed only when it isn't 3, and never with a cautious pick), trials at once \`--max-workers N\`, and the cap \`--max-rollouts 500\`. 0 steps passes no \`--max-iterations\` and no \`--reflection-model\`, and adds \`--baseline-only\` to the setup command.

### 6. Review

Show the setup as one summary in plain language, then the commands, and ask the user to start or to name a row to change. Say that any row can be changed, including the cases, crashes, and pick, which weren't asked. For a row of steps 2 to 5, go back to that step; for the others, take the new value here and check it against its rules below. Then show the review again.

\`\`\`text
optimize · capitals · 6 cases · 3 train / 2 validation / 1 test
  agent        strands-workspace/agent.py
  tune         instructions
  models       bedrock/global.anthropic.claude-sonnet-4-5…
  goal         the mean of every evaluator
  constraints  none
  cases        3 train / 2 validation / 1 test (default split)
  budget       4 steps × 4 candidates, 1 run of each case, 3 finalists
  parallel     4 trials at once
  crashes      a crashed run scores the worst value (default)
  pick         the best average score of the 3 finalists (default)
  ~61 rollouts · ~61 judge calls · price unknown
You can change any row, including cases, crashes, and pick, before I start.
\`\`\`

With constraints, their row also says how sure each must be (ex. \`tokens at most 4000, 90% sure each holds (default)\`). Under the summary, list every warning from steps 2 to 5 and from the rows below, and say that the run's model, judge, and proposer calls are paid and use the user's credentials, and that the first run installs the optimizer (about a minute, needs git and network).

The rows that take defaults:

- **Cases**: train guides the search, validation picks the winner, and test checks it on cases nothing else saw. Default: half train, and half of the rest test, the Strands CLI's default; when that leaves fewer than 2 validation cases or, with test cases, fewer than 2 test cases, take the nearest of these that doesn't: train 30%, 40%, 50%, 60%, 70%, or 80%, with the rest split half test, a third test, or no test. Show it as case counts: each share times the case count, rounded down, with the cases left over going to the largest remainders. The user's own split may be shares or counts (ex. "4 train, 1 validation, 1 test"). Rules: train and validation get a share above 0; the optimizer refuses fewer than 1 train or 1 validation case; with fewer than 2 validation or test cases, warn that the scores can be luck and say how many cases to add to reach 2 of each. Cases without a unique \`name\` are named in a copy of the experiment, so the user's file doesn't change.
- **How sure each constraint must be**, only with constraints. Default 90%; the user's own is a level above 0% and below 100%.
- **Crashes**. Default: a crashed run scores each evaluator's worst value. The user may instead leave crashed runs out of the scores, or give them a score of their own (ex. 0.5).
- **Pick**: how the winner is chosen from the finalists on validation. Default: the best average score. The user may instead pick cautiously, by a low estimate of each score that it reaches with a sureness above 50% and below 100% (ex. 75% or 90% sure).

**Build.**

- Cases: \`--split TRAIN,VALIDATION,TEST\`, with validation \`(1 - TRAIN) × (1 - test part)\` and test \`(1 - TRAIN) × test part\`. The shares must sum to 1 within 1e-9, so write enough digits (ex. \`0.6,0.266666666667,0.133333333333\`); counts become shares by dividing by the case count.
- Sureness: \`--feasibility-threshold X\`, passed only when it isn't 0.9.
- Crashes: nothing by default, \`--agent-failure-score none\` to leave crashed runs out, \`--agent-failure-score X\` for a score.
- Pick: nothing by default; X% sure adds \`--final-pick N:(1 - X)\` to the setup command (ex. 75% is \`N:0.25\`, 90% is \`N:0.1\`), with N the finalists of step 5, and replaces \`--n-finalists\`.

Then show the commands, built from the **Build** notes:

**Setup command**, from the same folder as step 1:

\`\`\`bash
node <skill_dir>/scripts/prepare.mjs setup [path/to/strands-workspace] --experiment <name> \\
  --tune <knob key> [--tune ...] [--model <model id> ...] [--baseline-only] [--final-pick N:Q]
\`\`\`

**Optimize flags**, appended to the \`command\` that setup prints:

\`\`\`text
--split <TRAIN,VALIDATION,TEST> [--max-iterations <steps>] --proposals-per-iteration <candidates> \\
--runs-per-candidate <runs> --max-workers <parallel> --max-rollouts 500 --seed 0 \\
[--objective ... [--pareto]] [--constraint ...] \\
[--feasibility-threshold X] [--agent-failure-score none|X] [--n-finalists N] [--reflection-model MODEL_ID]
\`\`\`

\`--reflection-model MODEL_ID\` changes the model rewriting text (default Bedrock \`global.anthropic.claude-sonnet-5-5\`); pass it only when the user asks and a text knob is tuned.

### 7. Run

**Setup.** Run the setup command. It prints progress to stderr and JSON to stdout. On the way it prepares the optimizer environment, as the Strands CLI does: it reuses the Strands CLI's environment at \`strands-workspace/strands-dev/tmp/.state/evals-env\`, or creates it from the workspace's \`.venv\` Python (a TypeScript agent: \`python3\`, or \`$PYTHON\`) and installs the pinned optimizer once into a shared folder under \`~/.strands/temporary-evals/\`. A Python agent's packages are added after the optimizer's. The JSON holds:

- \`folder\`: the run's folder, \`strands-workspace/strands-dev/experiments/<name>/optimizations/<stamp>/\`, where the Strands CLI keeps its own runs. The experiments folder's \`.gitignore\` already leaves out \`optimizations/\`, so nothing lands in git. Its \`.state/\` holds \`space.json\` (the tuned knobs as text, choice, and switch variables keyed by \`create_harness\` option, snake_case in Python) and \`task.py\`, which the CLI's own code writes and which loads the agent through the bridge.
- \`variables\`: the knobs that \`space.json\` tunes. Check they match the review.
- \`command\`: \`cd\` to the agent root, put the optimizer's \`bin\` first on \`PATH\`, and start \`strands-evals optimize run\` with \`--agent\`, \`--rollout\`, \`--search\` (with \`--baseline-only\`), \`--final-pick\` (with \`--final-pick\`), \`--base-dir\`, and \`--rich\`.
- \`resume\`: the same start for \`strands-evals optimize resume\`, for exit code 130.

If setup exits with code 2, show its last stderr lines. For a failed install, ask the user to check the network, the pip index settings, and that git is installed; for a missing \`.venv\` or \`strands-harness\`, ask them to install the agent's dependencies in \`strands-workspace/.venv\`.

**Start.** Run \`command\` plus the optimize flags in the background, with stdout, stderr, and the exit code in their own files in \`folder\`:

\`\`\`bash
F=<folder>
(<command> <optimize flags> > "$F/summary.txt" 2> "$F/run.log"; echo $? > "$F/run.exit") &
\`\`\`

If you can't run a background process, run it in the foreground with a long timeout and show the output when it ends. As soon as \`run.log\` prints \`strands-evals optimize: run folder <RUN_DIR>\`, tell the user the folder.

**Progress**, as the Strands CLI shows it: until \`$F/run.exit\` exists, about once a minute, relay each new line of \`run.log\` that starts with \`strands-evals optimize:\`, such as \`iteration N (<blocks>): P proposals, R rollouts\`, and any warning or error line, in plain words (ex. "step 2 of 4 done: 4 new versions tried, 61 rollouts so far"). Read new lines with \`tail -n +<next line> "$F/run.log"\`.

**Exit codes**, from \`$F/run.exit\`:

- **0**: the run finished. Go to step 8.
- **3 with \`<RUN_DIR>/result.json\`**: the search stopped on a proposer error, but the end phase ran and the result is valid. Show the error from \`run.log\`, then go to step 8.
- **3 without \`result.json\`**: the run stopped before it finished, most often at setup. Show the error line from \`run.log\`. When it says the baseline's train cases are unmeasured or every baseline trial failed, the agent or a model service failed (ex. \`NoCredentialsError\`, \`Could not load credentials\`): ask the user to check that the agent answers a case and that the credentials are fresh, then run setup and the command again.
- **2**: bad input (a flag, the agent, a trace-level evaluator with a TypeScript agent, or a space variable). Show the error, fix the value in its step or review row, and show the review again.
- **130**, or the process is gone without writing \`run.exit\` (killed): continue with \`(<resume> <RUN_DIR> --rich > "$F/summary.txt" 2>> "$F/run.log"; echo $? > "$F/run.exit") &\`, then follow it the same way. Finished trials aren't run again, and only \`--max-rollouts\`, \`--max-iterations\`, and \`--max-workers\` may change on resume.

### 8. Report

The report is \`$F/summary.txt\`, the optimizer's own summary (\`--rich\`): why the search stopped, what ships, every finalist on validation, the test check (the champion against the current agent on the test cases, with its 90% interval), the effects of each option, and the costs. Give the user its path to open, and the headline in plain words: the version that ships, or that no version beat the current agent; whether the test gain is likely real (the whole interval above 0), likely worse (below 0), or may be luck (it includes 0, and more test cases narrow it).

Nothing in the user's project changes. The champion's changes are keyed like \`space.json\`: \`<RUN_DIR>/best.diff\` holds each changed text (ex. \`instructions\`) as a diff under its key, and \`<RUN_DIR>/best.values.json\` holds each changed choice or switch as \`{"old": ..., "new": ...}\`, where a switch key such as \`builtin_tools_0\` is \`false\` when that entry is left out. Apply them to the agent's \`create_harness\` / \`createHarness\` call only when the user asks, and suggest evaluating the agent again after.
`
