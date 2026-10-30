Human-in-the-loop intervention handler.

Pauses agent execution before tool calls so a human can approve or deny them.

## AskCallback

```python
@runtime_checkable
class AskCallback(Protocol)
```

Defined in: [src/strands/vended\_interventions/hitl/hitl.py:33](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/hitl/hitl.py#L33)

Typed contract for an `ask` callback: prompt a human and return their response.

May be sync or async (an async impl lets the agent keep serving its event loop while waiting). Documents the expected signature for type-checkers/IDEs; it is intentionally not exported — customers just pass a function.

#### \_\_call\_\_

```python
def __call__(prompt: str, **kwargs: Any) -> Any | Awaitable[Any]
```

Defined in: [src/strands/vended\_interventions/hitl/hitl.py:41](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/hitl/hitl.py#L41)

Prompt the human and return their response (directly or as an awaitable).

## EvaluateCallback

```python
@runtime_checkable
class EvaluateCallback(Protocol)
```

Defined in: [src/strands/vended\_interventions/hitl/hitl.py:47](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/hitl/hitl.py#L47)

Typed contract for an `evaluate`/`evaluate_trust` callback.

Decides whether a response approves (or trusts) a tool call. Documents the expected signature for type-checkers/IDEs; intentionally not exported — customers just pass a function.

#### \_\_call\_\_

```python
def __call__(response: Any, **kwargs: Any) -> bool
```

Defined in: [src/strands/vended\_interventions/hitl/hitl.py:55](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/hitl/hitl.py#L55)

Return whether the response approves (or trusts) the pending tool call.

## HumanInTheLoop

```python
class HumanInTheLoop(InterventionHandler)
```

Defined in: [src/strands/vended\_interventions/hitl/hitl.py:94](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/hitl/hitl.py#L94)

Human-in-the-loop intervention handler that pauses agent execution before tool calls.

By default, ALL tools require approval and the agent pauses via interrupt/resume. Use `allowed_tools` to allow-list tools that run freely, and `ask` to provide inline prompting (CLI, custom UI).

**Example**:

```python
from strands import Agent, LLMDecisionModel
from strands.vended_interventions.hitl import HumanInTheLoop

# All tools require approval, agent pauses via interrupt (default)
agent = Agent(interventions=[HumanInTheLoop()])

# read_file runs freely, everything else pauses for approval
agent = Agent(interventions=[HumanInTheLoop(allowed_tools=["read_file"])])

# LLM-driven risk classification — only risky calls get escalated
agent = Agent(interventions=[HumanInTheLoop(
    allowed_tools=["read_file", "list_dir"],
    classifier=True,
)])

# Risk classification via a DecisionModel, on the model you pass it
agent = Agent(model=model, interventions=[HumanInTheLoop(classifier=LLMDecisionModel(model=model))])

# CLI mode - prompts in terminal inline
agent = Agent(interventions=[HumanInTheLoop(ask="stdio")])

# Custom UI - provide your own prompt function
async def slack_ask(prompt: str) -> str:
    return await slack_dm(user_id, prompt)

agent = Agent(interventions=[HumanInTheLoop(ask=slack_ask)])
```

#### \_\_init\_\_

```python
def __init__(*,
             allowed_tools: list[str] | None = None,
             classifier: bool | LLMClassifierConfig | DecisionModel
             | HumanInTheLoopClassifier | None = None,
             enable_trust: bool = False,
             evaluate_trust: EvaluateCallback | None = None,
             evaluate: EvaluateCallback | None = None,
             ask: AskCallback | Literal["stdio"] | None = None) -> None
```

Defined in: [src/strands/vended\_interventions/hitl/hitl.py:134](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/hitl/hitl.py#L134)

Initialize the handler.

**Arguments**:

-   `allowed_tools` - Tools that can execute WITHOUT human approval. All other tools require approval. Use `"*"` to allow all tools. Prefix with `!` to exclude specific tools from `"*"` (they still require approval). For example, `["read_file", "list_dir"]` lets only those two run freely, while `["*", "!delete_file"]` lets everything run freely except `delete_file`.
-   `classifier` - Determines how approval decisions are made for tools not in `allowed_tools`. Omitted/None: all non-allowed tools require approval.
-   `True` - uses the built-in LLM risk classifier with defaults.
-   `LLMClassifierConfig` - built-in LLM classifier with custom settings. Kept for backwards compatibility; prefer a `DecisionModel` for new code.
-   `DecisionModel` *e.g. `LLMDecisionModel`* - asked whether the call requires approval, against the same risk criteria as the LLM classifier. The decision model brings its own model and does not resolve through `agent.aux_model`. An `Uncertain` answer requires approval and carries its reason into the approval prompt; a definite answer carries no reason. Custom callable: your own classification logic.
-   `enable_trust` - When True, trust responses approve the tool AND remember it in `agent.state` for the rest of the session (won’t ask again). Works in both interrupt/resume and inline `ask` modes. Negated tools (`!tool`) cannot be trusted. With a `classifier`, trusting a tool disables argument-level risk classification for that tool name for the rest of the session. Defaults to False.
-   `evaluate_trust` - Custom trust response validator. Defaults to accepting `"t"`/`"trust"` (case-insensitive). When this returns True, the tool is approved AND trusted for the session. Only evaluated when `enable_trust` is True.
-   `evaluate` - Custom approval response validator. Defaults to accepting `True`, `"y"`/`"yes"` (case-insensitive).
-   `ask` - Controls how the human’s response is collected. Omitted (default): uses interrupt/resume - agent pauses, caller resumes with response.
-   `"stdio"` - prompts via CLI stdin. Agent blocks inline until the human responds. Note that stdio mode runs a blocking `input()` in a worker thread that cannot be cancelled, so it is intended for interactive CLI use rather than runs that may be cancelled mid-prompt. Custom callable: your own (optionally async) prompt logic (Slack, web UI, etc.). Agent blocks inline. A custom `ask` should return a concrete response; returning `None` (e.g. a dismissed dialog) is treated as an explicit deny. If it raises, the exception propagates and aborts the run
-   `(fail-closed)` - catch and return a deny value inside your callback if you prefer to proceed on error.

**Raises**:

-   `ValueError` - If `allowed_tools` is a single string rather than a list.
-   `TypeError` - If `classifier` is not a bool, `LLMClassifierConfig`, `DecisionModel`, or callable.

**Notes**:

`name` is a fixed class attribute, so at most one `HumanInTheLoop` can be registered per agent; layering two policies requires subclassing to rename.

#### before\_tool\_call

```python
async def before_tool_call(event: BeforeToolCallEvent,
                           **kwargs: Any) -> InterventionAction
```

Defined in: [src/strands/vended\_interventions/hitl/hitl.py:214](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_interventions/hitl/hitl.py#L214)

Request human approval before executing a tool that is not allow-listed or trusted.

Implemented as `async` so the inline `ask` path can await a human’s response (e.g. an HTTP round-trip to a Slack/web UI) without blocking the agent’s event loop. When no `ask` is configured this returns a `Confirm` that pauses the agent via interrupt instead.

**Arguments**:

-   `event` - The tool call event under evaluation.
-   `**kwargs` - Additional keyword arguments for future extensibility.

**Returns**:

Proceed if the tool is allow-listed, trusted, or approved inline; Deny if the inline answer rejects it; otherwise a Confirm action that pauses via interrupt.