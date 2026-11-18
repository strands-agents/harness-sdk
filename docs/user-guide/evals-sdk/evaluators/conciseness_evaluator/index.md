The `ConcisenessEvaluator` evaluates how concise an agent’s response is. It assesses whether the response communicates information efficiently without unnecessary verbosity, using a three-level scoring rubric.

## Key features

-   **Trace-Level Evaluation**: Evaluates the most recent turn in the conversation
-   **Three-Level Scoring**: Simple scale of Not Concise, Partially Concise, Perfectly Concise
-   **Async Support**: Supports both synchronous and asynchronous evaluation
-   **Structured Reasoning**: Provides step-by-step reasoning for each evaluation

## When to use

Use the `ConcisenessEvaluator` when you need to:

-   Ensure agents don’t produce unnecessarily verbose responses
-   Optimize response length for user experience
-   Detect padding or filler content in agent outputs
-   Compare verbosity across different agent configurations

## Evaluation level

This evaluator operates at the **TRACE\_LEVEL**, evaluating the most recent turn in the conversation.

## Parameters

### `model` (optional)

-   **Type**: `Union[Model, str, None]`
-   **Default**: `None` (uses default Bedrock model)
-   **Description**: The model to use as the judge.

### `system_prompt` (optional)

-   **Type**: `str | None`
-   **Default**: `None` (uses built-in template)
-   **Description**: Custom system prompt for the judge model.

### `include_inputs` (optional)

-   **Type**: `bool`
-   **Default**: `True`
-   **Description**: Whether to include the input prompt in the evaluation context.

### `version` (optional)

-   **Type**: `str`
-   **Default**: `"v0"`
-   **Description**: Prompt template version.

## Scoring system

| Rating | Score | Description |
| --- | --- | --- |
| Not Concise | 0.0 | Response is excessively verbose or padded |
| Partially Concise | 0.5 | Response could be shorter but isn’t egregiously verbose |
| Perfectly Concise | 1.0 | Response communicates information efficiently |

A response passes the evaluation if the score is >= 0.5.

## Basic usage

Required: Session ID Trace Attributes

When using `StrandsInMemorySessionMapper`, you **must** include session ID trace attributes in your agent configuration. This prevents spans from different test cases from being mixed together in the memory exporter.

```python
import asyncio

from strands import Agent
from strands_evals import Case, Experiment
from strands_evals.evaluators import ConcisenessEvaluator
from strands_evals.mappers import StrandsInMemorySessionMapper
from strands_evals.telemetry import StrandsEvalsTelemetry

telemetry = StrandsEvalsTelemetry().setup_in_memory_exporter()

def task_function(case: Case) -> dict:
    agent = Agent(
        trace_attributes={"session.id": case.session_id},
        callback_handler=None
    )
    response = agent(case.input)
    spans = telemetry.in_memory_exporter.get_finished_spans()
    mapper = StrandsInMemorySessionMapper()
    session = mapper.map_to_session(spans, session_id=case.session_id)
    return {"output": str(response), "trajectory": session}

cases = [
    Case(name="brief-answer", input="What is 2 + 2?")
]

experiment = Experiment(cases=cases, evaluators=[ConcisenessEvaluator()])
async def main():
    report = await experiment.run_evaluations_async(task_function)
    report.run_display()

asyncio.run(main())
```

## Related evaluators

-   [**CoherenceEvaluator**](/docs/user-guide/evals-sdk/evaluators/coherence_evaluator/index.md): Evaluates logical consistency
-   [**ResponseRelevanceEvaluator**](/docs/user-guide/evals-sdk/evaluators/response_relevance_evaluator/index.md): Evaluates relevance to user questions
-   [**HelpfulnessEvaluator**](/docs/user-guide/evals-sdk/evaluators/helpfulness_evaluator/index.md): Evaluates helpfulness from user perspective

## Related pages

- [Coherence evaluator](/docs/user-guide/evals-sdk/evaluators/coherence_evaluator/index.md) (1 shared tag)
- [Goal success rate evaluator](/docs/user-guide/evals-sdk/evaluators/goal_success_rate_evaluator/index.md) (1 shared tag)
- [Helpfulness evaluator](/docs/user-guide/evals-sdk/evaluators/helpfulness_evaluator/index.md) (1 shared tag)
- [Interactions evaluator](/docs/user-guide/evals-sdk/evaluators/interactions_evaluator/index.md) (1 shared tag)
- [Output evaluator](/docs/user-guide/evals-sdk/evaluators/output_evaluator/index.md) (1 shared tag)
- [Trusted Message History](/docs/user-guide/sdk/safety-security/trusted-message-history/index.md) (1 shared tag)
- [Built-in Modes](/docs/user-guide/sdk/context-management/built-in-modes/index.md) (1 shared tag)
- [Context Estimation](/docs/user-guide/sdk/context-management/context-estimation/index.md) (1 shared tag)
- [Context management](/docs/user-guide/sdk/context-management/index.md) (1 shared tag)
- [Custom Strategies](/docs/user-guide/sdk/context-management/custom-strategies/index.md) (1 shared tag)
