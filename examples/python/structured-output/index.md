This tutorial teaches you how to get reliable, typed, validated data from your Strands agents using structured output. Instead of parsing free-form text, you define a Pydantic model and the agent returns a validated Python object — ready for downstream code, APIs, and workflows.

## Overview

The core idea is simple: you give the agent a prompt **and** a Pydantic model describing the shape you want, and you get back a validated, typed object instead of free-form text.

Under the hood, the SDK registers your model as a dynamic tool, the LLM calls it to produce the data, and Pydantic validates the result — retrying automatically if validation fails. See [How It Works](#how-it-works) for the full mechanics.

## Tutorial Details

| Information | Details |
| --- | --- |
| **Strands Features** | Structured Output, Pydantic Validation, Tool Integration |
| **Agent Pattern** | Single agent with structured output |
| **Tools** | `calculator` (defined in the notebook) |
| **Model** | Claude Sonnet 4.5 on Amazon Bedrock |

## How It Works

1.  Developer defines a Pydantic `BaseModel` describing the desired output schema
2.  The model is passed to the agent via `structured_output_model=MyModel`
3.  The SDK converts the Pydantic model into a tool specification and registers it as a dynamic tool
4.  The LLM processes the prompt, optionally using regular tools to gather information
5.  The LLM calls the structured output tool with data matching the schema
6.  Pydantic validates the output — on failure, the error is sent back and the LLM self-corrects
7.  On success, the validated object is available at `result.structured_output`

## Prerequisites

-   Python 3.10 or later
-   AWS account with [Amazon Bedrock](https://aws.amazon.com/bedrock/) model access configured
-   [Model access](https://docs.aws.amazon.com/bedrock/latest/userguide/model-access-modify.html) enabled for Claude Sonnet 4.5
-   Basic understanding of Python and [Pydantic](https://docs.pydantic.dev/)
-   Familiarity with Strands Agents basics [(see Tutorial 01)](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/01-first-agent/)

## Tutorial Structure

```plaintext
19-structured-output/
├── README.md
├── requirements.txt
└── structured-output.ipynb
```

| File | Description |
| --- | --- |
| [structured-output.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/19-structured-output/structured-output.ipynb) | Interactive notebook covering the core structured output patterns |

## What You’ll Learn

-   **Your First Structured Output**: Define a flat Pydantic model, pass it to an agent, and access typed results — both sync and async
-   **Complex Schemas**: Build nested models with `List`, `Optional`, field validators, and enum constraints
-   **Validation & Self-Correction**: Watch the automatic retry loop fire when validation fails, inspect the retry trail in `agent.messages`, handle `StructuredOutputException`, and customize the forcing prompt
-   **Tools + Structured Output**: Combine regular tools with structured output so agents can gather data and return structured results

## Installation

Install the required dependencies:

```bash
pip install -r requirements.txt
```

## Running the Examples

1.  Open the notebook: [structured-output.ipynb](https://github.com/strands-agents/samples/blob/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/19-structured-output/structured-output.ipynb)
2.  Run cells sequentially — each section builds on the previous one
3.  Observe the agent’s structured output in each example

> **Note:** The exact field values will vary between runs since the LLM generates content dynamically. The structure and types will always match your Pydantic model.

## Key Concepts

-   **Structured Output**: A feature that makes agents return validated Pydantic objects instead of free-form text
-   **`structured_output_model`**: The parameter (on Agent constructor or per-call) that specifies the Pydantic model to use
-   **Structured Output Tool**: A dynamic tool the SDK auto-registers from your Pydantic model — the LLM calls it to produce structured data
-   **Validation & Self-Correction**: When the LLM’s output fails Pydantic validation, the SDK sends the error back and the LLM retries automatically
-   **Forcing**: If the LLM ignores the structured output tool, the SDK forces it by restricting available tools and setting `tool_choice`
-   **`StructuredOutputException`**: Raised when the LLM fails to produce valid structured output even after forcing
-   **`structured_output_prompt`**: A customizable message sent to the LLM when forcing is triggered

## Additional Resources

-   [Strands Agents Documentation](https://strandsagents.com/)
-   [Structured Output User Guide](https://strandsagents.com/latest/user-guide/concepts/agents/structured-output/)
-   [Pydantic Documentation](https://docs.pydantic.dev/)
-   [Strands Tools Repository](https://github.com/strands-agents/tools)

## Next Steps

-   Learn about [Memory](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/06-memory/) to persist agent memory across sessions
-   Explore [Agents as Tools](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/10-agents-as-tools/) to compose structured output agents into larger systems
-   Try [Graph Workflows](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/12-graph/) to build multi-step pipelines with structured data flowing between nodes

## Upstream source

- [View this sample at the imported commit](https://github.com/strands-agents/samples/tree/3c9ebca88ad8906ca77147753d951c5e2a7123bd/python/01-learn/19-structured-output)
