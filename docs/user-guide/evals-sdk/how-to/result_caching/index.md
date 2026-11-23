The `EvaluationDataStore` caches task execution results so you can re-run evaluators against the same data without re-invoking your agent. Use it when agent calls are expensive, slow, or non-deterministic: run the agent once, cache the results, then iterate on evaluators.

## Quickstart

```python
import asyncio

from strands_evals import Case, Experiment, LocalFileTaskResultStore
from strands_evals.evaluators import OutputEvaluator

store = LocalFileTaskResultStore("./cached_results")

cases = [
    Case(name="q1", input="What is the capital of France?"),
    Case(name="q2", input="What is 2 + 2?"),
]

experiment = Experiment(cases=cases, evaluators=[OutputEvaluator(rubric="Score 1.0 if correct.")])

async def main():
    # First run: executes the task and caches results
    report = await experiment.run_evaluations_async(my_task, evaluation_data_store=store)

    # Second run: loads cached results, skips task execution
    report = await experiment.run_evaluations_async(my_task, evaluation_data_store=store)

asyncio.run(main())
```

## How it works

When you pass an `evaluation_data_store` to `run_evaluations`:

1.  For each case, the store is checked for a cached result using `case.name` as the key
2.  If found, the cached `EvaluationData` is used directly and the task function is not called
3.  If not found, the task runs normally and the result is saved to the store
4.  Evaluators then run against the (cached or fresh) `EvaluationData`

Caution

All cases must have unique, non-`None` names when using a result store. The experiment validates this before execution.

## LocalFileTaskResultStore

The built-in `LocalFileTaskResultStore` saves one JSON file per case in a directory:

```python
from strands_evals import LocalFileTaskResultStore

store = LocalFileTaskResultStore("./my_cache")
# Creates: ./my_cache/q1.json, ./my_cache/q2.json, etc.
```

Each file contains the full `EvaluationData` (input, output, trajectory, environment state, etc.) serialized as JSON.

## Custom stores

Implement the `EvaluationDataStore` protocol for any storage backend:

```python
from strands_evals.evaluation_data_store import EvaluationDataStore
from strands_evals.types.evaluation import EvaluationData

class S3ResultStore:
    def __init__(self, bucket: str, prefix: str):
        self.bucket = bucket
        self.prefix = prefix

    def load(self, case_name: str) -> EvaluationData | None:
        # Fetch from S3, return None if not found
        ...

    def save(self, case_name: str, result: EvaluationData) -> None:
        # Upload to S3
        ...
```

The protocol requires just two methods: `load(case_name) -> EvaluationData | None` and `save(case_name, result) -> None`.

## Related documentation

-   [Task Decorator](/docs/user-guide/evals-sdk/how-to/eval_task/index.md): Simplify task function boilerplate
-   [Experiment Management](/docs/user-guide/evals-sdk/how-to/experiment_management/index.md): Save and load experiments
-   [Serialization](/docs/user-guide/evals-sdk/how-to/serialization/index.md): Experiment serialization formats

## Related pages

- [Prompt caching](/docs/user-guide/sdk/model-providers/prompt-caching/index.md) (1 shared tag)
- [Anthropic](/docs/user-guide/sdk/model-providers/anthropic/index.md) (1 shared tag)
- [Amazon Bedrock](/docs/user-guide/sdk/model-providers/amazon-bedrock/index.md) (1 shared tag)
