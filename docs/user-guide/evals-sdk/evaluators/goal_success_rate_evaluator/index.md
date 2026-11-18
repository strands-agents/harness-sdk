The `GoalSuccessRateEvaluator` evaluates whether all user goals were successfully achieved in a conversation. It provides a holistic assessment of whether the agent accomplished what the user set out to do, considering the entire conversation session. A complete example can be found [here](https://github.com/strands-agents/harness-sdk/blob/main/site/docs/examples/evals-sdk/goal_success_rate_evaluator.py).

## Key features

-   **Session-Level Evaluation**: Evaluates the entire conversation session
-   **Goal-Oriented Assessment**: Focuses on whether user objectives were met
-   **Dual Mode**: Basic (inferred goals) and assertion-based (explicit success criteria)
-   **Binary Scoring**: Simple Yes/No or SUCCESS/FAILURE for clear determination
-   **Structured Reasoning**: Provides step-by-step reasoning for the evaluation
-   **Async Support**: Supports both synchronous and asynchronous evaluation
-   **Holistic View**: Considers all interactions in the session

## When to use

Use the `GoalSuccessRateEvaluator` when you need to:

-   Measure overall task completion success
-   Evaluate if user objectives were fully achieved
-   Assess end-to-end conversation effectiveness
-   Track success rates across different scenarios
-   Identify patterns in successful vs. unsuccessful interactions
-   Optimize agents for goal achievement

## Evaluation level

This evaluator operates at the **SESSION\_LEVEL**, meaning it evaluates the entire conversation session as a whole, not individual turns or tool calls.

## Parameters

### `version` (optional)

-   **Type**: `str`
-   **Default**: `"v0"`
-   **Description**: Prompt template version used for both the basic and assertion templates when no custom `system_prompt` or `assertion_system_prompt` is supplied.

### `model` (optional)

-   **Type**: `Union[Model, str, None]`
-   **Default**: `None` (uses default Bedrock model)
-   **Description**: The model to use as the judge. Can be a model ID string or a Model instance.

### `system_prompt` (optional)

-   **Type**: `str | None`
-   **Default**: `None` (uses built-in template)
-   **Description**: Custom system prompt for basic mode evaluation.

### `assertion_system_prompt` (optional)

-   **Type**: `str | None`
-   **Default**: `None` (uses built-in template)
-   **Description**: Custom system prompt for assertion-based evaluation.

## Scoring system

### Basic Mode (no assertions)

The evaluator infers user goals from the conversation and checks whether they were met:

-   **Yes (1.0)**: All user goals were successfully achieved
-   **No (0.0)**: User goals were not fully achieved

### Assertion mode (with `expected_assertion`)

When `expected_assertion` is set on the case, the evaluator judges against explicit success criteria instead of inferring goals:

-   **SUCCESS (1.0)**: Agent behavior satisfies the specified assertions
-   **FAILURE (0.0)**: Agent behavior does not satisfy the assertions

A session passes the evaluation only if the score is 1.0.

### Using assertions

```python
cases = [
    Case(
        name="booking",
        input="I need to book a flight to Paris for next Friday",
        expected_assertion="""
        1. Agent confirmed the destination (Paris)
        2. Agent confirmed the travel date (next Friday)
        3. Agent provided a booking confirmation or next steps
        """
    )
]

experiment = Experiment(cases=cases, evaluators=[GoalSuccessRateEvaluator()])
```

Assertions are human-authored statements describing expected agent actions, responses, or behaviors. They give you precise control over what “success” means for each test case.

## Basic usage

Required: Session ID Trace Attributes

When using `StrandsInMemorySessionMapper`, you **must** include session ID trace attributes in your agent configuration. This prevents spans from different test cases from being mixed together in the memory exporter.

```python
import asyncio

from strands import Agent
from strands_evals import Case, Experiment
from strands_evals.evaluators import GoalSuccessRateEvaluator
from strands_evals.mappers import StrandsInMemorySessionMapper
from strands_evals.telemetry import StrandsEvalsTelemetry

# Setup telemetry
telemetry = StrandsEvalsTelemetry().setup_in_memory_exporter()
memory_exporter = telemetry.in_memory_exporter

# Define task function
def user_task_function(case: Case) -> dict:
    agent = Agent(
        trace_attributes={
            "gen_ai.conversation.id": case.session_id,
            "session.id": case.session_id
        },
        callback_handler=None
    )
    agent_response = agent(case.input)

    # Map spans to session
    finished_spans = memory_exporter.get_finished_spans()
    mapper = StrandsInMemorySessionMapper()
    session = mapper.map_to_session(finished_spans, session_id=case.session_id)

    return {"output": str(agent_response), "trajectory": session}

# Create test cases
test_cases = [
    Case[str, str](
        name="math-1",
        input="What is 25 * 4?",
        metadata={"category": "math", "goal": "calculate_result"}
    ),
    Case[str, str](
        name="math-2",
        input="Calculate the square root of 144",
        metadata={"category": "math", "goal": "calculate_result"}
    ),
]

# Create evaluator
evaluator = GoalSuccessRateEvaluator()

# Run evaluation
experiment = Experiment[str, str](cases=test_cases, evaluators=[evaluator])

async def main():
    report = await experiment.run_evaluations_async(user_task_function)
    report.run_display()

asyncio.run(main())
```

## Evaluation output

The `GoalSuccessRateEvaluator` returns `EvaluationOutput` objects with:

-   **score**: `1.0` (Yes) or `0.0` (No)
-   **test\_pass**: `True` if score >= 1.0, `False` otherwise
-   **reason**: Step-by-step reasoning explaining the evaluation
-   **label**: “Yes” or “No”

## What gets evaluated

The evaluator examines:

1.  **Available Tools**: Tools that were available to the agent
2.  **Conversation Record**: Complete history of all messages and tool executions
3.  **User Goals**: Implicit or explicit goals from the user’s queries
4.  **Final Outcome**: Whether the conversation achieved the user’s objectives

The judge determines if the agent successfully helped the user accomplish their goals by the end of the session.

## Best practices

1.  **Use with Proper Telemetry Setup**: The evaluator requires trajectory information captured via OpenTelemetry
2.  **Define Clear Goals**: Ensure test cases have clear, measurable objectives
3.  **Capture Complete Sessions**: Include all conversation turns in the trajectory
4.  **Test Various Complexity Levels**: Include simple and complex goal scenarios
5.  **Combine with Other Evaluators**: Use alongside helpfulness and trajectory evaluators

## Common patterns

### Pattern 1: Task completion

Evaluate if specific tasks were completed successfully.

### Pattern 2: Multi-step goals

Assess achievement of goals requiring multiple steps.

### Pattern 3: Information retrieval

Determine if users obtained the information they needed.

## Example scenarios

### Scenario 1: Successful goal achievement

```plaintext
User: "I need to book a flight from NYC to LA for next Monday"
Agent: [Searches flights, shows options, books selected flight]
Final: "Your flight is booked! Confirmation number: ABC123"
Evaluation: Yes (1.0) - Goal fully achieved
```

### Scenario 2: Partial achievement

```plaintext
User: "I need to book a flight from NYC to LA for next Monday"
Agent: [Searches flights, shows options]
Final: "Here are available flights. Would you like me to book one?"
Evaluation: No (0.0) - Goal not completed (booking not finalized)
```

### Scenario 3: Failed goal

```plaintext
User: "I need to book a flight from NYC to LA for next Monday"
Agent: "I can help with general travel information."
Evaluation: No (0.0) - Goal not achieved
```

### Scenario 4: Complex multi-goal success

```plaintext
User: "Find the cheapest flight to Paris, book it, and send confirmation to my email"
Agent: [Searches flights, compares prices, books cheapest option, sends email]
Final: "Booked the €450 flight and sent confirmation to your email"
Evaluation: Yes (1.0) - All goals achieved
```

## Common issues and solutions

### Issue 1: No evaluation returned

**Problem**: Evaluator returns empty results. **Solution**: Ensure trajectory contains a complete session with at least one agent invocation span.

### Issue 2: Ambiguous goals

**Problem**: Unclear what constitutes “success” for a given query. **Solution**: Provide clearer test case descriptions or expected outcomes in metadata.

### Issue 3: Partial success scoring

**Problem**: Agent partially achieves goals but evaluator marks as failure. **Solution**: This is by design - the evaluator requires full goal achievement. Consider using HelpfulnessEvaluator for partial success assessment.

## Differences from other evaluators

-   **vs. HelpfulnessEvaluator**: Goal success is binary (achieved/not achieved), helpfulness is graduated
-   **vs. OutputEvaluator**: Goal success evaluates overall achievement, output evaluates response quality
-   **vs. TrajectoryEvaluator**: Goal success evaluates outcome, trajectory evaluates the path taken

## Use cases

### Use case 1: Customer service

Evaluate if customer issues were fully resolved.

### Use case 2: Task automation

Measure success rate of automated task completion.

### Use case 3: Information retrieval

Assess if users obtained all needed information.

### Use case 4: Multi-step workflows

Evaluate completion of complex, multi-step processes.

## Related evaluators

-   [**HelpfulnessEvaluator**](/docs/user-guide/evals-sdk/evaluators/helpfulness_evaluator/index.md): Evaluates helpfulness of individual responses
-   [**TrajectoryEvaluator**](/docs/user-guide/evals-sdk/evaluators/trajectory_evaluator/index.md): Evaluates the sequence of actions taken
-   [**OutputEvaluator**](/docs/user-guide/evals-sdk/evaluators/output_evaluator/index.md): Evaluates overall output quality with custom criteria
-   [**FaithfulnessEvaluator**](/docs/user-guide/evals-sdk/evaluators/faithfulness_evaluator/index.md): Evaluates if responses are grounded in context

## Related pages

- [Coherence evaluator](/docs/user-guide/evals-sdk/evaluators/coherence_evaluator/index.md) (1 shared tag)
- [Conciseness evaluator](/docs/user-guide/evals-sdk/evaluators/conciseness_evaluator/index.md) (1 shared tag)
- [Helpfulness evaluator](/docs/user-guide/evals-sdk/evaluators/helpfulness_evaluator/index.md) (1 shared tag)
- [Interactions evaluator](/docs/user-guide/evals-sdk/evaluators/interactions_evaluator/index.md) (1 shared tag)
- [Output evaluator](/docs/user-guide/evals-sdk/evaluators/output_evaluator/index.md) (1 shared tag)
- [Trusted Message History](/docs/user-guide/sdk/safety-security/trusted-message-history/index.md) (1 shared tag)
- [Built-in Modes](/docs/user-guide/sdk/context-management/built-in-modes/index.md) (1 shared tag)
- [Context Estimation](/docs/user-guide/sdk/context-management/context-estimation/index.md) (1 shared tag)
- [Context management](/docs/user-guide/sdk/context-management/index.md) (1 shared tag)
- [Custom Strategies](/docs/user-guide/sdk/context-management/custom-strategies/index.md) (1 shared tag)
