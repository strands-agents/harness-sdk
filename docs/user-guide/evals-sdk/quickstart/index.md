Strands Evaluation measures an agent’s quality before you ship it and after. This quickstart takes you to a first running evaluation: install the SDK, write one experiment, score an agent’s output with a built-in evaluator, and read the results. From there, the [next steps](#next-steps) cover trajectory and helpfulness scoring, the CLI, custom evaluators, and automated test generation.

## Install the SDK

First, ensure that you have Python 3.10+ installed.

Create and activate a virtual environment:

```bash
python -m venv .venv
```

-   macOS / Linux: `source .venv/bin/activate`
-   Windows (CMD): `.venv\Scripts\activate.bat`
-   Windows (PowerShell): `.venv\Scripts\Activate.ps1`

Install the evaluation SDK along with the core Strands Agents SDK and tools:

```bash
pip install strands-agents-evals strands-agents
```

## Configure credentials

Strands Evaluation uses the same model providers as Strands Agents. By default, evaluators use Amazon Bedrock with Claude as the judge model.

To run the example below, configure AWS credentials with permission to invoke Claude, using one of:

1.  **Environment variables**: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optionally `AWS_SESSION_TOKEN`
2.  **AWS credentials file**: `aws configure`
3.  **IAM roles**: on AWS services like EC2, ECS, or Lambda

Enable model access in the Amazon Bedrock console following the [AWS documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access-modify.html).

## Run your first evaluation

An evaluation has three parts: a task that produces the agent’s output, cases that define the inputs and what you expect, and an evaluator that scores each result. The `OutputEvaluator` scores a response against a rubric you write.

Create `basic_eval.py`:

```python
from strands import Agent
from strands_evals import eval_task, Case, Experiment
from strands_evals.evaluators import OutputEvaluator

# The @eval_task decorator handles boilerplate: just return an Agent
@eval_task()
def get_response():
    return Agent(
        system_prompt="You are a helpful assistant that provides accurate information.",
        callback_handler=None
    )

# Create test cases
test_cases = [
    Case[str, str](
        name="knowledge-1",
        input="What is the capital of France?",
        expected_output="The capital of France is Paris.",
        metadata={"category": "knowledge"}
    ),
    Case[str, str](
        name="knowledge-2",
        input="What is 2 + 2?",
        expected_output="4",
        metadata={"category": "math"}
    ),
    Case[str, str](
        name="reasoning-1",
        input="If it takes 5 machines 5 minutes to make 5 widgets, how long does it take 100 machines to make 100 widgets?",
        expected_output="5 minutes",
        metadata={"category": "reasoning"}
    )
]

# Create evaluator with custom rubric
evaluator = OutputEvaluator(
    rubric="""
    Evaluate the response based on:
    1. Accuracy - Is the information factually correct?
    2. Completeness - Does it fully answer the question?
    3. Clarity - Is it easy to understand?

    Score 1.0 if all criteria are met excellently.
    Score 0.5 if some criteria are partially met.
    Score 0.0 if the response is inadequate or incorrect.
    """,
    include_inputs=True
)

# Create and run experiment
experiment = Experiment[str, str](cases=test_cases, evaluators=[evaluator])
report = experiment.run_evaluations(get_response)

# Display results
print("=== Basic Output Evaluation Results ===")
report.run_display()

# Save experiment for later analysis
experiment.to_file("basic_evaluation")
print("\nExperiment saved to ./basic_evaluation.json")
```

Run it:

```bash
python -u basic_eval.py
```

`run_display()` prints each case’s score, whether it passed, and the judge’s reasoning, followed by the overall statistics. The experiment is saved to `basic_evaluation.json`, so you can reload or compare it later. Evaluating many cases? `Experiment` also offers `run_evaluations_async` to run them concurrently and return the same report.

The @eval\_task decorator

The `@eval_task()` decorator eliminates boilerplate. Your function can return an `Agent` (auto-invoked with `case.input`), a `str`, or a `dict`. For trace-based evaluators, use `@eval_task(TracedHandler())` to automatically collect spans. See the [Task Decorator guide](/docs/user-guide/evals-sdk/how-to/eval_task/index.md) for details.

## Next steps

You have a running evaluation. From here, a natural path forward:

1.  [Eval SOP](/docs/user-guide/evals-sdk/eval-sop/index.md) - follow a repeatable process for evaluating and improving an agent
2.  [Evaluators Overview](/docs/user-guide/evals-sdk/evaluators/index.md) - pick the right built-in scorer (trajectory, helpfulness, correctness, deterministic) for what you want to measure
3.  [Custom Evaluators](/docs/user-guide/evals-sdk/evaluators/custom_evaluator/index.md) - build domain-specific scoring when the built-ins don’t fit
4.  [Command-Line Interface](/docs/user-guide/evals-sdk/cli/index.md) - run experiments from the shell and wire evaluation into CI
5.  [Experiment Generator](/docs/user-guide/evals-sdk/experiment_generator/index.md) - generate a broad test suite automatically

## Related pages

- [Choosing an Agent Foundation](/docs/user-guide/migrate/choosing-an-agent-foundation/index.md) (1 shared tag)
- [Get started](/docs/user-guide/sdk/quickstart/overview/index.md) (1 shared tag)
- [Get started with Strands Box](/docs/user-guide/box/getting-started/index.md) (1 shared tag)
- [Python Quickstart](/docs/user-guide/sdk/quickstart/python/index.md) (1 shared tag)
- [Strands Shell quickstart](/docs/user-guide/shell/quickstart/index.md) (1 shared tag)
- [TypeScript Quickstart](/docs/user-guide/sdk/quickstart/typescript/index.md) (1 shared tag)
- [Red teaming quickstart](/docs/user-guide/evals-sdk/red-teaming/quickstart/index.md) (1 shared tag)
- [Build a Voice Agent](/docs/user-guide/sdk/bidi/quickstart/index.md) (1 shared tag)
