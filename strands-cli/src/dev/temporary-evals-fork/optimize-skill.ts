/**
 * The optimize skill of strands-evals, vendored verbatim (minus its frontmatter) from
 * strands-agents/evals#646 (workstream/optimizer-workflow eeee890).
 * It is the workflow for an optimization; strands dev only replaces the parts in workflow-skills.ts.
 * Replace this with a read of the installed strands-evals once the skill lands on its mainline.
 */
export const TEMPORARY_OPTIMIZE_SKILL_VERSION = '0.9.0'

export const TEMPORARY_OPTIMIZE_SKILL = `# optimize

Sets up and runs \`strands-evals optimize run\` on an agent built with strands-harness: a Python \`agent.py\` (\`create_harness\`) or a TypeScript \`agent.ts\` (\`createHarness\`). The optimizer takes the agent file itself (\`--agent agent.py\` or \`--agent agent.ts\`): it tunes the arguments of the call that builds \`agent\`, and runs the file again for each trial, with a fresh session and a copy of the memory folder. A TypeScript agent runs in a Node.js worker, and its usage and steps are traced as a Python agent's are.

\`<skill_dir>\` below is the folder holding this file.

The optimizer is on the evals branch \`workstream/optimizer-workflow\`, not on \`main\` yet; the skill uses the Python of the installed \`strands-evals\` command (step 1).

## Steps

Ask in plain chat, one step at a time unless a step says to ask its questions together. Every list has at most three numbered options before a short "Your own" option, the default first and marked \`(Default)\`, except the first question (no "Your own") and the knobs question (every tunable knob, step 2); always accept a free-form answer (ex. "2 steps", "drop effort", "tokens at most 4000"). When an answer breaks a rule of its step, say which and ask again. If you can't wait for replies (ex. a non-interactive run), take each default, say so, and continue.

Questions and their options are plain language: they name what changes and what it costs, never a flag, an option name in code, or a file path. Flags live in each step's **Build** notes, which are for you, and appear to the user only in the review's command (step 6).

The case split, how sure each constraint must be, how crashes count, and how the winner is picked aren't asked: they take their defaults and show as review rows the user can change (step 6).

### 1. Find the inputs and ask for a request

Look only in these places, with these commands from the current folder; don't search the tree or open other files. When something isn't there, ask for it instead of looking further.

\`\`\`bash
ls strands-dev/.config strands-workspace/strands-dev/.config agent.py agent.ts strands-workspace/agent.py strands-workspace/agent.ts 2>/dev/null
E=$(find strands-dev/experiments strands-workspace/strands-dev/experiments -mindepth 2 -maxdepth 2 \\
  -name '*.json' ! -name '*.report.json' 2>/dev/null)
[ -n "$E" ] && echo "$E" || find . strands-workspace -maxdepth 1 -name '*.json' 2>/dev/null | xargs grep -l '"evaluators"' 2>/dev/null
\`\`\`

The first line lists the agent files; the rest lists the workspace's experiments, or else the JSON files with evaluators in the current folder and \`strands-workspace/\`.

- **Agent.** With a \`.config\`, the agent is its \`agent.entrypoint\`, relative to its \`agent.path\` (itself relative to the \`.config\`'s folder). Otherwise it is the \`agent.py\` or \`agent.ts\` listed. Its \`agent\` must be built by a call in the file: \`agent = create_harness(...)\` in Python, or an exported \`agent\` from \`createHarness(...)\` in TypeScript (also \`.mts\`, \`.js\`, \`.mjs\`). With no agent, or several, ask for the path of "the file that builds your agent with create_harness or createHarness".
- **TypeScript** only: Node.js 22.18 or later must be on \`PATH\`, and the agent file must be able to import \`@strands-agents/harness\`. Check from the project with \`node --version\` and \`node --input-type=module -e "import('@strands-agents/harness')"\`; when either fails, give the user the fix (install a newer Node.js, or \`npm install @strands-agents/harness\`) and wait, without installing anything yourself.
- **Project.** The \`.config\`'s agent path, else the agent file's folder. Commands run from there.
- **Python.** The interpreter of the \`strands-evals\` command on \`PATH\`, for both languages. The optimizer imports a Python agent in that strands-evals process, so it must also have the agent's packages. \`strands-harness\` comes with the optimizer's \`[optimization]\` extra, as it did under the Strands CLI, so the agent's code must work with the version that extra pins; the check below catches an install without the extra:

  \`\`\`bash
  SE=$(command -v strands-evals) && SE=$(realpath "$SE") && PY="$(dirname "$SE")/python" \\
    && { [ -x "$PY" ] || PY=$(head -1 "$SE" | sed 's/^#!//; s/ .*//'); } \\
    && "$PY" -c "import strands_evals.optimization, strands_harness" && strands-evals optimize run --help > /dev/null
  \`\`\`

  When there is no \`strands-evals\`, the import fails, or the command doesn't start (ex. a moved environment left a dead interpreter path in it), don't install anything yourself: give the user this command for the Python their agent runs with (ex. their activated environment's \`python\`), say that its \`optimization\` extra pins \`strands-harness\` to 0.4.x, and wait until they have run it:

  \`\`\`bash
  python -m pip install 'strands-agents-evals[optimization] @ git+https://github.com/strands-agents/evals@workstream/optimizer-workflow'
  \`\`\`
- **Experiments.** The files the second line lists. For each, read only its counts: \`jq '{cases: (.cases | length), evaluators: [.evaluators[].evaluator_type]}' <file>\` (each \`evaluator_type\` is a metric name); skip a file \`jq\` can't read that way.

Then ask the first question:

\`\`\`text
Describe the optimization you want, or answer "step by step".
1. Step by step (Default): I walk you through the experiment, what may change, the goal, and the budget.
2. Describe it: for example, "make the support agent shorter without losing helpfulness, about 100 rollouts".
\`\`\`

Next, unless the request names one, ask which experiment to use: up to three, by name with their cases and evaluators (ex. \`capitals: 6 cases, scored by OutputEvaluator\`), the most cases first as the default, then "Your own: another experiment's name or path", naming any others found in one line under the list. With none found, ask for the path of an experiment file (the JSON file with cases and evaluators that \`strands-evals run\` reads), and stop if there is none.

When the user describes the run, take every value of steps 2 to 5 and every review row from that text and the files, using each default where the text says nothing, ask no setup question, and go to step 6. A value that breaks a rule becomes the closest valid one and is flagged in the review.

### 2. Knobs: what may change

Read the agent's \`create_harness(...)\` or \`createHarness(...)\` call and offer the knobs below with their current values. An option the call doesn't pass is at the harness default (effort and context manager auto; caching and skills on; background tasks off; the model the harness's own). In TypeScript, background tasks can be tuned only when the call writes them. The system prompt is a text knob only when the call passes one, and then replaces the instructions. Name in one not-tunable line a knob set in code (a variable, a call, a model instance). Memory and session aren't offered: every trial starts with a fresh session and a copy of the memory folder. Tools, MCP servers, and plugins can't be switched one by one yet.

**Effort levels** depend on the model: offer auto, low, medium, and high, which most models accept, and take others through "Your own". Say that a level the model doesn't offer makes its trials fail and spends their rollouts. Effort isn't tunable when the model is a model instance rather than an id string: the harness ignores effort for those.

This question is exempt from the three-option rule: list every tunable knob as a numbered option, the defaults first and marked \`(Default)\`, then "Your own", then the not-tunable line. The user may pick several: use the host's multi-select question UI when it has one, with the defaults pre-selected; otherwise accept several numbers in one reply.

\`\`\`text
What may the optimizer change? Pick any (ex. "1, 3").
1. instructions (Default): rewritten by the proposer model; now "Answer geography questions in one short sentence."
2. model: try other models next to bedrock/global.anthropic.claude-sonnet-4-5...; name the models to try
3. effort: auto, low, medium, or high; now auto
4. prompt caching: auto, on, or off; now on
5. context manager: auto, agentic, or off; now auto
6. background tasks: on or off; now off
7. skills: on or off; now on (their text isn't rewritten)
8. Your own: for example, "only the instructions and effort low or medium"
Every trial starts with a fresh session and a copy of the memory folder, so trials don't share state.
\`\`\`

A choice the user narrows (ex. "effort low or medium") always keeps the current value. With model picked, ask for the model ids to try.

**Defaults**: the instructions, or the system prompt when the agent passes one. When the request is about cost, length, or speed, effort, prompt caching, and the context manager are defaults too. A model choice is a default only with model ids the user named.

**Rules.** At least one knob is tuned. When a text knob is tuned, warn: Reflection, the proposer, writes shell commands and runs them on this machine with the user's environment, credentials, and network. It is not a sandbox, and text in the cases can carry prompt injection. Run it in a container or VM that has only the credentials the run needs.

**Build.** Each knob is a \`--tune\` over an argument of the call, named as the call names it: \`system_prompt\`, \`context_manager\`, and \`background_tasks\` in Python; \`systemPrompt\`, \`contextManager\`, and \`backgroundTasks\` in TypeScript. The instructions are tuned unless \`--no-tune-instructions\` is passed; a Python agent that doesn't set them needs \`instructions=""\` in the call. The system prompt is \`--tune system_prompt\` (or \`systemPrompt\`). A choice is \`--tune 'OPTION=JSON_LIST'\` with a list that includes the current value, for \`model\`, \`effort\`, \`caching\`, the context manager, background tasks, or \`skills\` (on/off are \`true\`/\`false\`, the context manager's off is \`false\`), ex. \`--tune 'effort=["auto","low","high"]'\`. For an option the call leaves out, the current value is \`"auto"\` for effort and the context manager and \`true\` for caching and skills; the model is \`null\` in Python and the harness's default model id in TypeScript (ex. \`bedrock/global.anthropic.claude-opus-5\`); background tasks are \`null\` in Python.

### 3. Objective: what to improve

**Metrics** are the experiment's evaluator names (\`Helpfulness\` resolves to \`HelpfulnessEvaluator\`) and the usage metrics tokens, input tokens, output tokens, cache read tokens, cache write tokens, seconds, and model calls.

Ask what to improve; limits come in step 4. For options 1 to 3, ask the follow-up in one short message.

\`\`\`text
What should the optimizer improve?
1. Maximize a metric: an evaluator's score, or the mean of every evaluator (Default)
2. Minimize a metric: ex. tokens, output tokens, seconds, or model calls
3. Balance several metrics: weigh them together, or find the best trade-offs without weighing
4. Your own: for example, "fewer output tokens, mean of every evaluator scoring >= 0.8"
\`\`\`

Follow-ups, in plain words:

- **Maximize**: which metric; default the mean of every evaluator, or the one evaluator the request names.
- **Minimize**: which usage metric; default tokens, output tokens when the request is about answer length, or seconds when it's about speed.
- **Balance**: which metrics, at least two (ex. "OutputEvaluator and tokens"); whether to weigh them (default), with how much each counts (ex. "OutputEvaluator twice as much as tokens"), or find the best trade-offs; for tokens or time, how big a change matters (default 1000 tokens, 10 seconds).

**Default**: the mean of every evaluator. When the request is about length or cost, balancing the evaluators and tokens (output tokens when it's about answer length); about speed, the evaluators and seconds.

**Rules.** Every metric is one listed above; a metric appears once; an experiment with no evaluator needs a usage goal (option 2); balancing needs two metrics or more; a metric name with \`:\` can't be used.

**Build.** Each goal is one \`--objective {maximize,minimize}:METRIC[:weight=X][:scale=X]\` (maximize an evaluator, minimize a usage metric); several form a weighted sum, and \`--pareto\` makes them a front instead. The mean of every evaluator passes no \`--objective\`. Balancing sets \`weight=\` from how much each counts, or adds \`--pareto\` for the best trade-offs; so does "Your own" when the user asks for trade-offs without weighing. A limit in a "Your own" answer (ex. "scoring >= 0.8") becomes a constraint of step 4, not a goal. With several goals, each usage metric needs \`scale=\`, the size of a meaningful change (default \`scale=1000\` for tokens, \`scale=10\` for seconds; \`scale=100\` on output tokens weighs 100 tokens like an evaluator's whole 0-1 range).

### 4. Constraints: limits on top of the objective

Ask which constraints the winner must also meet, with what can be constrained listed under the options, the experiment's own evaluators first. Only a candidate meeting every constraint on validation ships.

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

An evaluator with its own score range shows that range instead of 0 to 1.

**Default**: none, or option 2 when the objective only minimizes a usage metric (step 3, option 2); then say why: with only tokens or time to improve, an agent that answers badly, or not at all, can look best.

**Rules.** Each constraint is one metric from the list, "at least" or "at most", and a number; a metric name with \`<\`, \`>\`, or \`=\` can't be used.

**Build.** Each constraint is \`--constraint 'METRIC>=X'\` or \`--constraint 'METRIC<=X'\`.

### 5. Budget

Ask all five settings in one message, with the rollout estimate for the case counts of the default split (step 6). A setting the reply leaves out keeps its default; recompute the estimate from the reply and show it before moving on.

\`\`\`text
Budget: change any of these in one reply (ex. "2 steps, 2 runs"); the rest keep their default.
1. Steps: rounds of proposing and testing new versions of the agent. Default 4.
2. Candidates per step: new versions tried in each round. Default 4.
3. Runs of each case: how often each case is repeated per version, to average out noise. Default 1.
4. Finalists: the best versions re-checked on the validation cases to pick the winner. Default 3.
5. Trials at once: how many runs go in parallel; changes speed, not cost. Default 4.

With these values: about 61 rollouts and 61 judge calls.
\`\`\`

Work out the estimate yourself; show the user only the totals. Rollouts (one run of the agent on one case) are \`runs × (train × (1 + steps × candidates) + validation × (finalists + 1) + test × tested)\`, with \`tested\` 2 (the winner and the current agent), from the case counts of the split; judge calls are about rollouts × evaluators. Neither the judge's nor Reflection's own calls count against the budget. Under best trade-offs (step 3, balancing without weighing), at least 5 finalists are re-checked, so the finalists default is 5 and \`tested\` is the finalists plus 1; say so in step 3's follow-up.

**Rules**, stated only when an answer breaks one: every setting is a whole number; steps are 0 or more, and 0 measures only the current agent (no new versions, no proposer model); the others are at least 1; under best trade-offs, finalists are at least 5. The cap is 500 rollouts: above it, suggest fewer steps, candidates, or runs, or raise the cap if the user asks; it must at least cover the estimate without the steps. When one step's trials (candidates × train cases × runs) exceed the trials at once, say that steps run in batches and take longer.

**Build.** Steps are \`--max-iterations N\`, candidates \`--proposals-per-iteration N\`, runs \`--runs-per-candidate N\`, finalists \`--n-finalists N\` (only when it isn't 3, and never with a cautious pick, step 6), trials at once \`--max-workers N\`, and the cap \`--max-rollouts 500\`. 0 steps passes no \`--max-iterations\` and no \`--reflection-model\`, but \`--search "$F/hooks.py:baseline_only"\` (step 7).

### 6. Review

Show the setup as one summary, then the command, and ask the user to start or to name a row to change. For a row of steps 2 to 5, go back to that step; for a default row, take the new value here and check it against its rules below. Then show the review again.

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

With constraints, their row also says how sure each must be (ex. \`tokens at most 4000, 90% sure each holds (default)\`). Under the summary, list every warning from steps 2 to 5 and from the rows below, and say that the model, judge, and proposer calls are paid and use the user's credentials.

The default rows:

- **Cases**: train guides the search, validation picks the winner, and test checks it on cases nothing else saw. Default: half train, and half of the rest test; when that leaves fewer than 2 validation cases or, with test cases, fewer than 2 test cases, the nearest of: train 30%, 40%, 50%, 60%, 70%, or 80%, with the rest split half test, a third test, or no test, that doesn't. Show case counts: each share times the case count, rounded down, with the leftover cases going to the largest remainders. The user's own split may be shares or counts (ex. "4 train, 1 validation, 1 test"). Rules: at least 1 train and 1 validation case; with fewer than 2 validation or test cases, warn that the scores can be luck and say how many cases to add to reach 2 of each.
- **How sure each constraint must be**, only with constraints: default 90%; the user's own is above 0% and below 100%.
- **Crashes**: default, a crashed run scores each evaluator's worst value. The user may instead leave crashed runs out of the scores, or give them a score (ex. 0.5).
- **Pick**: how the winner is chosen from the finalists on validation. Default, the best average score. The user may instead pick cautiously, by a low estimate of each score that it reaches with a sureness above 50% and below 100% (ex. 75% or 90% sure).

**Build.**

- Cases: \`--split TRAIN,VALIDATION,TEST\`, validation \`(1 - TRAIN) × (1 - test part)\` and test \`(1 - TRAIN) × test part\`, summing to 1 within 1e-9, so write enough digits (ex. \`0.6,0.266666666667,0.133333333333\`); counts become shares by dividing by the case count.
- Sureness: \`--feasibility-threshold X\`, only when it isn't 0.9.
- Crashes: nothing by default, \`--agent-failure-score none\` to leave crashed runs out, \`--agent-failure-score X\` for a score.
- Pick: nothing by default; X% sure writes \`final_pick\` into hooks.py (step 7) with \`q = 1 - X\` (ex. 75% is 0.25) and N the finalists, and passes \`--final-pick "$F/hooks.py:final_pick"\`.
- Proposer model: \`--reflection-model MODEL_ID\` (default Bedrock \`global.anthropic.claude-sonnet-5-5\`), only when the user asks and a text knob is tuned.

The command is step 7's **Start**, with the flags of the **Build** notes of steps 2 to 6 and \`--seed 0\` after \`--rich\`.

### 7. Run

**Run folder.** \`F\` is \`strands-dev/experiments/<name>/optimizations/<stamp>/\` for an experiment of a strands-dev workspace, where the Strands CLI keeps its runs; otherwise \`<project>/.strands-evals/runs/<stamp>/\`, with \`<stamp>\` the UTC time as \`YYYYMMDD-HHMMSS\`. Suggest adding \`.strands-evals/\` to the project's \`.gitignore\` when it's a git repository that doesn't ignore it. Every case needs a unique \`name\`: when one doesn't have it, write a copy with every case named (keep existing names, add \`case-<n>\` to the rest, \`-2\`, \`-3\` to repeats) as \`$F/experiment.json\` and run that.

**hooks.py**, only for 0 steps or a cautious pick: write \`$F/hooks.py\` with the part each needs:

\`\`\`python
from strands_evals.optimization import FinalPick, LowerBound, Schedule, Search


class BaselineOnly(Schedule):  # 0 steps: measure only the current agent
    name = "baseline_only"

    def next(self, ctx):
        return None


baseline_only = Search([], schedule=BaselineOnly())
final_pick = FinalPick(n_finalists=N, rule=LowerBound(q=Q))  # a cautious pick
\`\`\`

**Start.** Run in the background from the project, with stdout, stderr, and the exit code in their own files:

\`\`\`bash
cd <project> && (strands-evals optimize run <experiment> \\
  --agent <absolute path of the agent file> --base-dir "$F/record" --rich <flags of steps 2 to 6> \\
  > "$F/summary.txt" 2> "$F/run.log"; echo $? > "$F/run.exit") &
\`\`\`

If you can't run a background process, run it in the foreground with a long timeout and show the output when it ends. As soon as \`run.log\` prints \`strands-evals optimize: run folder <RUN_DIR>\`, tell the user the folder.

**Progress**: until \`$F/run.exit\` exists, about once a minute, relay each new \`run.log\` line that starts with \`strands-evals optimize:\` (ex. \`iteration N (<blocks>): P proposals, R rollouts\`) and any warning or error, in plain words (ex. "step 2 of 4 done: 4 new versions tried, 61 rollouts so far"). Read new lines with \`tail -n +<next line> "$F/run.log"\`.

**Exit codes**, from \`$F/run.exit\`:

- **0**: the run finished. Go to step 8.
- **3 with a \`strands-evals optimize: continue with ... resume <RUN_DIR>\` line in \`run.log\`**: the search stopped on a proposer error (ex. Reflection's model failed) before picking a winner; the rollouts spent are kept. Show the error, and tell the user the run can continue where it stopped once the cause is fixed (ex. fresh credentials for the proposer's model). Don't start a new run.
- **3 without that line**: a setup or runtime failure. Show the error line. When it says the baseline's train cases are unmeasured or every baseline trial failed, the agent or a model service failed (ex. \`NoCredentialsError\`): ask the user to check that the agent answers a case and that the credentials are fresh, then run again in a new run folder.
- **2**: bad input (a flag, the experiment, a \`--tune\` the agent's call can't take, or an agent file the optimizer can't load, ex. one whose \`agent\` no \`create_harness\` or \`createHarness\` call built, or a TypeScript agent without Node.js 22.18 or \`@strands-agents/harness\`). Show the error, fix the value in its step or review row, and show the review again.
- **130**, or the process is gone without writing \`run.exit\` (killed): tell the user the run stopped early and give its folder.

After a 3 with the \`continue\` line or a 130, say the user can ask to resume it (see "Resuming a run").

### 8. Report

The report is \`$F/summary.txt\`, the optimizer's own summary: why the search stopped, what ships, every finalist on validation, the test check (the winner against the current agent on the test cases, with its 90% interval), the effects of each option, and the costs. Give the user its path and the headline in plain words: the version that ships, or that none beat the current agent; whether the test gain is likely real (the whole interval above 0), likely worse (below 0), or may be luck (it includes 0; more test cases narrow it).

A run can exit 0 before its test check ran: skipped because the budget couldn't afford it, or waiting to re-run trials that hit infrastructure failures (ex. throttling). \`jq -r '.test_reason // "done"' "<RUN_DIR>/result.json"\` prints \`done\`, or why the test check didn't fully run. When it isn't \`done\`, tell the user in plain words: what ships is final; when the reason is the budget or trials waiting to re-run, resuming the run can still run the test check, with a larger rollout cap when the budget was the reason.

Nothing in the user's project changes. \`<RUN_DIR>/best.diff\` holds each changed text (ex. \`instructions\`) as a diff under its option name, and \`<RUN_DIR>/best.values.json\` each changed choice as \`{"old": ..., "new": ...}\`. Apply them to the agent's \`create_harness\` or \`createHarness\` call only when the user asks, and suggest evaluating the agent again after.

## Resuming a run

Resume only when the user explicitly asks; never on your own. A run can be resumed when it was killed (130, or no \`run.exit\`), stopped on a proposer error (3 with the \`continue\` line), or finished before its test check ran (step 8); any other failed run starts over as a new run. Skip steps 1 to 6: take the run folder \`$F\` the user names, else the newest resumable one under the experiment's \`optimizations/\` (or \`<project>/.strands-evals/runs/\`), and confirm it with the user. \`<RUN_DIR>\` is the path on the \`strands-evals optimize: run folder\` line of \`$F/run.log\`; without that line the run never started, so there is nothing to resume. With \`PY\` and \`<project>\` as in step 1, run:

\`\`\`bash
cd <project> && (strands-evals optimize resume "<RUN_DIR>" --rich \\
  [--max-rollouts N] [--max-iterations N] [--max-workers N] \\
  > "$F/summary.txt" 2>> "$F/run.log"; echo $? > "$F/run.exit") &
\`\`\`

Those three are the only settings that may change on resume (a larger \`--max-rollouts\` lets a skipped test check run). Finished trials aren't run again. Follow it as in step 7 and report as in step 8.
`
