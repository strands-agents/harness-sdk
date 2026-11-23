An evaluator scores what your agent produced. You give it an agent’s output, or a whole trace, and it returns a score, a pass or fail, and the reasoning behind the call. Strands ships evaluators for four things you usually want to check, plus fast code-based checks and a base class for anything custom:

-   **Quality** measures whether a response is helpful, accurate, coherent, and on topic, and whether a multi-turn trajectory holds together.
-   **Safety** screens a response for harmful content, inappropriate refusals, and stereotyping.
-   **Multimodal** judges responses grounded in an image or document.
-   **Agentic** measures tool use, goal completion, and how an agent behaves when things fail.
-   **Skill** measures whether a skill-equipped agent picked the right skill and then followed its steps.
-   **Deterministic** evaluators run code-based checks with no model in the loop.
-   **Custom** evaluators cover logic the built-ins do not.

[Quality](#quality)Helpfulness, faithfulness, correctness, coherence, and relevance.

[Safety](#safety)Harmful content, refusals, and stereotyping.

[Multimodal](#multimodal)Score responses against an image or document.

[Agentic](#agentic)Tool use, goal success, and failure handling.

[Skill](#skill)Skill selection and instruction following for skill-equipped agents.

[Deterministic](#deterministic)Fast code-based checks with no LLM judge.

[Custom](#custom)Build evaluation logic the built-ins do not cover.

## Choose an evaluator

Pick evaluators along two axes: what you want to check (the six groups above) and at what granularity:

| Level | Scope | Use case |
| --- | --- | --- |
| **OUTPUT\_LEVEL** | A single response | Quality of an individual output |
| **TOOL\_LEVEL** | A single tool call | Tool selection and parameter accuracy |
| **TRACE\_LEVEL** | A single turn | Turn-by-turn analysis |
| **SESSION\_LEVEL** | A full conversation | End-to-end goal achievement |

`TRACE_LEVEL`, `SESSION_LEVEL`, and `TOOL_LEVEL` are the values of the SDK’s `EvaluationLevel` enum, set through an evaluator’s `evaluation_level`. Evaluators that leave it unset (`OutputEvaluator`, `TypedRubricEvaluator`, the multimodal and skill evaluators, `TrajectoryEvaluator`, and `InteractionsEvaluator`) receive the agent’s output or full result directly, so the level shown for those is their conceptual scope.

Combine several evaluators in one experiment to assess different aspects at once. Each evaluator’s page documents its parameters and scoring in full; the tables below summarize what each one checks and links to that detail.

## Quality

Score whether a response is useful and well-formed, and whether a multi-turn trajectory of actions holds together.

| Evaluator | Level | What it checks |
| --- | --- | --- |
| [OutputEvaluator](/docs/user-guide/evals-sdk/evaluators/output_evaluator/index.md) | OUTPUT\_LEVEL | Any subjective quality against a rubric you write |
| [TypedRubricEvaluator](/docs/user-guide/evals-sdk/evaluators/typed_rubric_evaluator/index.md) | OUTPUT\_LEVEL | Yes/no, scale, and choice questions scored from a decision model’s probabilities |
| [HelpfulnessEvaluator](/docs/user-guide/evals-sdk/evaluators/helpfulness_evaluator/index.md) | TRACE\_LEVEL | Response helpfulness from the user’s perspective |
| [FaithfulnessEvaluator](/docs/user-guide/evals-sdk/evaluators/faithfulness_evaluator/index.md) | TRACE\_LEVEL | Factual accuracy and groundedness |
| [CorrectnessEvaluator](/docs/user-guide/evals-sdk/evaluators/correctness_evaluator/index.md) | TRACE\_LEVEL | Factual correctness, with optional reference comparison |
| [CoherenceEvaluator](/docs/user-guide/evals-sdk/evaluators/coherence_evaluator/index.md) | TRACE\_LEVEL | Logical consistency and reasoning quality |
| [ConcisenessEvaluator](/docs/user-guide/evals-sdk/evaluators/conciseness_evaluator/index.md) | TRACE\_LEVEL | Brevity and freedom from unnecessary verbosity |
| [ResponseRelevanceEvaluator](/docs/user-guide/evals-sdk/evaluators/response_relevance_evaluator/index.md) | TRACE\_LEVEL | Relevance of a response to the user’s question |
| [TrajectoryEvaluator](/docs/user-guide/evals-sdk/evaluators/trajectory_evaluator/index.md) | SESSION\_LEVEL | Sequence of actions and tool-usage patterns |
| [InteractionsEvaluator](/docs/user-guide/evals-sdk/evaluators/interactions_evaluator/index.md) | SESSION\_LEVEL | Conversation patterns and interaction quality |

## Safety

Screen a response for content you do not want an agent to produce, or for inappropriate refusals of valid requests. Each returns a binary classification.

| Evaluator | Level | What it checks |
| --- | --- | --- |
| [HarmfulnessEvaluator](/docs/user-guide/evals-sdk/evaluators/harmfulness_evaluator/index.md) | TRACE\_LEVEL | Dangerous or offensive content |
| [RefusalEvaluator](/docs/user-guide/evals-sdk/evaluators/refusal_evaluator/index.md) | TRACE\_LEVEL | Refusals of valid requests the agent should address |
| [StereotypingEvaluator](/docs/user-guide/evals-sdk/evaluators/stereotyping_evaluator/index.md) | TRACE\_LEVEL | Biased or stereotypical content against groups |

## Multimodal

Judge responses that depend on an image or document, using a multimodal LLM as the judge.

| Evaluator | Level | What it checks |
| --- | --- | --- |
| [MultimodalOutputEvaluator](/docs/user-guide/evals-sdk/evaluators/multimodal_output_evaluator/index.md) | OUTPUT\_LEVEL | Any quality against a rubric for image or document-to-text tasks |
| [MultimodalOverallQualityEvaluator](/docs/user-guide/evals-sdk/evaluators/multimodal_overall_quality_evaluator/index.md) | OUTPUT\_LEVEL | Likert-5 overall quality across accuracy, adherence, completeness, and coherence |
| [MultimodalCorrectnessEvaluator](/docs/user-guide/evals-sdk/evaluators/multimodal_correctness_evaluator/index.md) | OUTPUT\_LEVEL | Binary fact-check of a response against the image content |
| [MultimodalFaithfulnessEvaluator](/docs/user-guide/evals-sdk/evaluators/multimodal_faithfulness_evaluator/index.md) | OUTPUT\_LEVEL | Binary hallucination check for claims not verifiable from the image |
| [MultimodalInstructionFollowingEvaluator](/docs/user-guide/evals-sdk/evaluators/multimodal_instruction_following_evaluator/index.md) | OUTPUT\_LEVEL | Binary constraint compliance (count, format, scope, order, style) |

## Agentic

Measure how an agent uses tools, whether it completes the user’s goal, and how it behaves when a tool fails.

| Evaluator | Level | What it checks |
| --- | --- | --- |
| [ToolSelectionAccuracyEvaluator](/docs/user-guide/evals-sdk/evaluators/tool_selection_evaluator/index.md) | TOOL\_LEVEL | Whether the correct tools were selected |
| [ToolParameterAccuracyEvaluator](/docs/user-guide/evals-sdk/evaluators/tool_parameter_evaluator/index.md) | TOOL\_LEVEL | Accuracy of the parameters passed to tools |
| [InstructionFollowingEvaluator](/docs/user-guide/evals-sdk/evaluators/instruction_following_evaluator/index.md) | TRACE\_LEVEL | Compliance with explicit format, length, style, and content constraints |
| [GoalSuccessRateEvaluator](/docs/user-guide/evals-sdk/evaluators/goal_success_rate_evaluator/index.md) | SESSION\_LEVEL | Whether the user’s goal was achieved |
| [FailureCommunicationEvaluator](/docs/user-guide/evals-sdk/evaluators/failure_communication_evaluator/index.md) | TRACE\_LEVEL | How clearly the agent communicates failures to the user |
| [PartialCompletionEvaluator](/docs/user-guide/evals-sdk/evaluators/partial_completion_evaluator/index.md) | TRACE\_LEVEL | What fraction of a goal was achieved despite failures |
| [RecoveryStrategyEvaluator](/docs/user-guide/evals-sdk/evaluators/recovery_strategy_evaluator/index.md) | TRACE\_LEVEL | Quality of recovery actions when tools fail |

## Skill

For agents that load skills at runtime, measure both halves of that behavior: which skill the agent picked, and whether it then followed the skill’s steps. Both read the full trajectory and return one result per invoked skill.

| Evaluator | Level | What it checks |
| --- | --- | --- |
| [SkillSelectionAccuracyEvaluator](/docs/user-guide/evals-sdk/evaluators/skill_selection_accuracy_evaluator/index.md) | SESSION\_LEVEL | Whether invoking each skill was an appropriate choice |
| [SkillInstructionFollowingEvaluator](/docs/user-guide/evals-sdk/evaluators/skill_instruction_following_evaluator/index.md) | SESSION\_LEVEL | How fully the agent followed each invoked skill’s steps |

## Deterministic

Run fast, code-based checks with no LLM judge, for regression tests and CI. The [Deterministic Evaluators](/docs/user-guide/evals-sdk/evaluators/deterministic_evaluators/index.md) page covers `Equals`, `Contains`, `StartsWith`, `ToolCalled`, `StateEquals`, and `SkillInvoked`. They operate at OUTPUT\_LEVEL or SESSION\_LEVEL.

[StructuredOutputSimilarity](/docs/user-guide/evals-sdk/evaluators/structured_output_evaluator/index.md) is deterministic too, but scores a structured output field by field rather than comparing whole objects, so a partially correct extraction reports which field to fix. It operates at OUTPUT\_LEVEL and needs the `stickler` extra.

## Custom

When no built-in fits, extend the base `Evaluator` class to implement your own logic. See [Custom Evaluators](/docs/user-guide/evals-sdk/evaluators/custom_evaluator/index.md).

## Run an evaluator

An evaluation has three parts: a task that produces the agent’s output, cases that define the inputs and what you expect, and an evaluator that scores each result. This runs the `OutputEvaluator` against a rubric:

```python
from strands import Agent
from strands_evals import eval_task, Case, Experiment
from strands_evals.evaluators import OutputEvaluator

@eval_task()
def get_response():
    return Agent(system_prompt="Answer accurately and concisely.")

cases = [
    Case[str, str](
        name="capital",
        input="What is the capital of France?",
        expected_output="Paris",
    )
]

evaluator = OutputEvaluator(rubric="Score 1.0 if the answer is correct, else 0.0.")

report = Experiment[str, str](cases=cases, evaluators=[evaluator]).run_evaluations(
    get_response
)
report.run_display()
```

`run_display()` prints each case’s score, whether it passed, and the judge’s reasoning. To run many cases concurrently, use `run_evaluations_async` for the same report.

### From the command line

The same check runs without a script through [`strands-evals run`](/docs/user-guide/evals-sdk/cli/run/index.md). `--rubric` wires up an `OutputEvaluator` automatically, and `--evaluator` accepts built-in shortnames such as `helpfulness` or `correctness`:

```bash
# Rubric-scored check, equivalent to the Python example above
strands-evals run \
  --input "What is the capital of France?" \
  --rubric "Score 1.0 if the answer is correct, else 0.0." \
  --agent my_agent:build_agent

# Built-in evaluator by shortname
strands-evals run \
  --input "Is 17 prime?" \
  --evaluator helpfulness \
  --agent my_agent:build_agent
```

See [`strands-evals run`](/docs/user-guide/evals-sdk/cli/run/index.md) for the full shortname list and how `--agent` resolves.

## Next steps

-   New to evaluation? Work through the [quickstart](/docs/user-guide/evals-sdk/quickstart/index.md), which runs this example end to end and reads the results.
-   Ready to combine scorers? Pick the evaluators for what you want to check from the tables above, starting with [OutputEvaluator](/docs/user-guide/evals-sdk/evaluators/output_evaluator/index.md) for free-form quality.
-   Building your own? See [Custom Evaluators](/docs/user-guide/evals-sdk/evaluators/custom_evaluator/index.md).
-   Want to know *why* cases fail? [Detectors](/docs/user-guide/evals-sdk/detectors/index.md) add automatic failure detection and root cause analysis.
-   Generating traces to score? [Simulators](/docs/user-guide/evals-sdk/simulators/index.md) drive the conversations that evaluators assess.