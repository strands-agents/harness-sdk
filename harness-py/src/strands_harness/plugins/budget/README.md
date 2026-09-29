# Budget control for Strands Harness

`BudgetPlugin` records model-token costs against a USD limit and blocks new model calls after recorded spend reaches that limit. Use it when an agent needs a persistent spending boundary and an inspectable transaction history.

## What is this plugin?

The budget plugin is a Strands hook-based control for `strands-harness`. It reads token usage from each model call, calculates cost from configured per-token rates, and stores budget state through a Strands `Storage` backend.

Install the package before using the plugin:

```bash
pip install strands-harness
```

## What does it do?

For each attached agent, the plugin:

- Uses `agent.session_id` as the key for budget state.
- Stores the budget limit, recorded spend, and one transaction per billed model call.
- Checks the persisted spend before each model call.
- Blocks the next model call when recorded spend reaches the limit.
- Supports custom rates and optional Amazon Bedrock rates from the AWS Price List API.

A pricing source is required for accounting. Calls without a matching rate are not billed. A call that crosses the limit completes because its output-token usage is only available afterward; the following model call is blocked.

## Basic example

Configure rates in USD per single token. A rate key can be an exact runtime model ID or a substring of it. Exact matches take precedence, followed by the longest matching substring.

```python
from strands_harness import create_harness
from strands_harness.plugins import BudgetPlugin

MODEL_ID = "qwen.qwen3-coder-next"

budget = BudgetPlugin(
    budget=10.0,
    custom_rates={
        MODEL_ID: (
            0.22 / 1_000_000,
            1.80 / 1_000_000,
        ),
    },
)

agent = create_harness(
    model=MODEL_ID,
    session={"id": "documentation-project"},
    plugins=[budget],
)

agent("Summarize the open issues in this repository.")
```

The first value in each rate tuple is the input-token rate. The second value is the output-token rate.

## How do I use it with sessions?

Pass a stable session ID to reuse the same budget when you construct another agent. Conversation state and budget state use the same identifier, but they have independent storage backends.

```python
from strands_harness import create_harness
from strands_harness.plugins import BudgetPlugin

MODEL_ID = "qwen.qwen3-coder-next"
SESSION_ID = "customer-42"

budget = BudgetPlugin(
    budget=5.0,
    custom_rates={MODEL_ID: (0.22 / 1_000_000, 1.80 / 1_000_000)},
)

agent = create_harness(
    model=MODEL_ID,
    session={"id": SESSION_ID},
    plugins=[budget],
)

agent("Create a release checklist for this project.")
```

When `session=True` or the session configuration omits `id`, the harness generates a new ID. Read it from `agent.session_id` and pass it to a later agent to resume the same conversation and budget key.

By default, the budget manager writes `.agent/strands-budget/<session_id>.json`. Passing `session={"dir": ...}` changes conversation storage only. Pass `storage=` to `BudgetPlugin` to change budget storage.

## How do I use it without sessions?

Set `session=False` when you do not need persisted conversation history. Strands still creates a random session ID for the agent instance, and the plugin uses that ID as its budget key.

```python
from strands_harness import create_harness
from strands_harness.plugins import BudgetPlugin

MODEL_ID = "qwen.qwen3-coder-next"

budget = BudgetPlugin(
    budget=2.0,
    custom_rates={MODEL_ID: (0.22 / 1_000_000, 1.80 / 1_000_000)},
)

agent = create_harness(
    model=MODEL_ID,
    session=False,
    plugins=[budget],
)

agent("Draft a concise pull request description.")
print(agent.session_id)
```

The generated ID remains stable across calls to this agent. A newly constructed agent receives a different ID, so it does not automatically reuse the previous budget. Supply a custom `Storage` backend and manage its key directly with `BudgetManager` when the application needs a different lifecycle.

## How do I use Amazon Bedrock pricing?

Install the AWS extra and provide credentials with the read-only `pricing:GetProducts` permission:

```bash
pip install "strands-harness[aws]"
```

Enable pricing for the Amazon Bedrock region used by the agent:

```python
from strands_harness import create_harness
from strands_harness.plugins import BudgetPlugin

budget = BudgetPlugin(
    budget=10.0,
    use_aws_pricing=True,
    aws_region="us-east-1",
)

agent = create_harness(
    model="bedrock/global.amazon.nova-lite-v1:0",
    session={"id": "bedrock-project"},
    plugins=[budget],
)

agent("Summarize this project structure.")
```

AWS pricing coverage depends on the products returned by the Price List API. If the request fails or the runtime model ID has no matching rate, that model call is not billed. Pass `custom_rates` with `use_aws_pricing=True` to add missing rates or replace fetched entries with the same key.

## How do I inspect or change a budget?

`BudgetManager` operations are asynchronous. Access the manager from the configured plugin and use the resolved `agent.session_id`.

```python
import asyncio

from strands_harness import create_harness
from strands_harness.plugins import BudgetPlugin

MODEL_ID = "qwen.qwen3-coder-next"

budget = BudgetPlugin(
    budget=5.0,
    custom_rates={MODEL_ID: (0.22 / 1_000_000, 1.80 / 1_000_000)},
)
agent = create_harness(
    model=MODEL_ID,
    session={"id": "budget-admin-example"},
    plugins=[budget],
)


async def inspect_budget() -> None:
    state = await budget.manager.load(agent.session_id)
    if state is not None:
        print(f"Spent: ${state.spent:.6f}")
        print(f"Remaining: ${state.remaining:.6f}")


asyncio.run(inspect_budget())
```

Use `set_budget()` to change the limit without clearing existing spend. Use `reset()` to clear spend and transactions while keeping the limit. `delete()` removes the state and makes the session unlimited until another budget is set.
