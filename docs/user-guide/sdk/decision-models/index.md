Some steps in an application need a closed answer rather than text. Is this message urgent? Which team handles this ticket? Does this tool call need a person’s approval? A decision model answers questions like these. You give it some input and a set of questions, each with a fixed set of choices, and it returns one answer per question that your code can branch on.

When the input doesn’t support any of the choices, the decision model can answer `Uncertain` instead of guessing, so your code can treat “the model isn’t sure” as its own case.

## How it works

A decision model has one method, `ask`. You call it with the input and the questions, and it returns the answers along with details about the call:

> **Diagram:** How a decision model call flows. Your code calls ask with the input and the questions. The decision model validates the questions and sends them to its backend, which is a model provider or your own. A result comes back to your code with one answer per question, each a choice or Uncertain, plus metadata and token usage. Each call is traced as a decision span.

-   **The input** is what the questions are about: a string, a message’s content, or a whole conversation.
-   **The questions** each have an id you choose and their choices: yes or no, or a list of labels.
-   **The decision model** validates the questions and sends them to its backend. The [LLM decision model](/docs/user-guide/sdk/decision-models/models/llm/index.md) uses a model provider; a custom decision model can use anything.
-   **The result** holds one answer per question, keyed by your ids, plus the call’s latency and token usage.

## Decision models and structured output

[Structured output](/docs/user-guide/sdk/agents/structured-output/index.md) also returns typed data, but you design the schema and the agent produces it at the end of its loop. A decision model is a single call outside the agent loop: the questions define the answer shape, and an uncertain answer is part of the result instead of a schema field you add and check yourself.

## Start here

[Quickstart](quickstart/index.md)Ask yes/no and multiple-choice questions and handle an uncertain answer.

## Use decision models

[Questions and answers](questions/index.md)Define choices, control uncertainty, and read the result.

[Decisions in an agent](agents/index.md)Ask from a tool and count the tokens toward the agent's request.

[Choose a decision model](models/index.md)Use a model provider, or write your own decision model.

[Observe decisions](observability/index.md)Trace each decision with OpenTelemetry.

## Related pages

- [Decisions in an agent](/docs/user-guide/sdk/decision-models/agents/index.md) (1 shared tag)
- [LLM decision model](/docs/user-guide/sdk/decision-models/models/llm/index.md) (1 shared tag)
- [Questions and answers](/docs/user-guide/sdk/decision-models/questions/index.md) (1 shared tag)
- [Supported decision models](/docs/user-guide/sdk/decision-models/models/index.md) (1 shared tag)
- [Decision model observability](/docs/user-guide/sdk/decision-models/observability/index.md) (1 shared tag)
- [Decision models quickstart](/docs/user-guide/sdk/decision-models/quickstart/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/decisions/decision_model.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/decision_model.py)
- [harness-sdk/strands-py/src/strands/decisions/types.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/decisions/types.py)

### TypeScript

- [harness-sdk/strands-ts/src/decisions/decision-model.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/decision-model.ts)
- [harness-sdk/strands-ts/src/decisions/types.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts)
