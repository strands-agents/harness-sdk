Iterative-refinement plugin for Strands agents.

Validates the agent’s response after each invocation; if it doesn’t satisfy the goal, feeds validator feedback back as a user message and re-enters the agent loop via `AfterInvocationEvent.resume`. Loops until validation passes, `max_attempts` is reached, `timeout` elapses, or one of the request’s `limits` is reached.

**Example**:

```python
from strands import Agent
from strands.vended_plugins.goal import GoalLoop

# Natural-language goal — judged by an internal Agent built from the host's model.
concise = GoalLoop(
    goal="At most 3 sentences, accessible to a 10-year-old, no jargon.",
    max_attempts=3,
)
agent = Agent(plugins=[concise])
agent("Explain how rainbows form.")
print(concise.last_result(agent))
```

**Example**:

```python
# Programmatic validator — pass a callable as `goal` to run your own check.
def word_count_validator(response, agent):
    text = " ".join(
        block["text"] for block in response["content"] if "text" in block
    )
    words = len(text.split())
    if words <= 50:
        return True
    return \{"passed": False, "feedback": f"Too long (\{words} words). Cap at 50."}

word_count = GoalLoop(goal=word_count_validator, max_attempts=5, timeout=30.0)
```

## ValidationOutcome

```python
@dataclass
class ValidationOutcome()
```

Defined in: [src/strands/vended\_plugins/goal/plugin.py:70](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/goal/plugin.py#L70)

Outcome a validator returns.

#### ValidatorReturn

Return type for programmatic validators.

Booleans are shorthand: True -> pass, False -> fail with no feedback. Use the dict form `\{"passed": bool, "feedback": str}` or `ValidationOutcome` when you have actionable feedback for the next attempt.

## Validator

```python
@runtime_checkable
class Validator(Protocol)
```

Defined in: [src/strands/vended\_plugins/goal/plugin.py:87](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/goal/plugin.py#L87)

Programmatic validator callable.

Must return True, False, a ValidationOutcome, or a dict with `passed` and optional `feedback` keys. May be sync or async.

The second argument is the host agent — read `agent.messages` for the full transcript (the same view the built-in NL judge sees), or any other state the validator needs.

#### \_\_call\_\_

```python
def __call__(response: Message, agent: Agent,
             **kwargs: Any) -> ValidatorReturn | Awaitable[ValidatorReturn]
```

Defined in: [src/strands/vended\_plugins/goal/plugin.py:98](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/goal/plugin.py#L98)

Validate the agent’s response.

#### GoalStopReason

Why a goal run ended. `"limit"` means one of the request’s `limits` was reached, so no further attempt could run.

## GoalAttempt

```python
@dataclass
class GoalAttempt()
```

Defined in: [src/strands/vended\_plugins/goal/plugin.py:109](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/goal/plugin.py#L109)

Single attempt summary preserved on GoalResult.

## GoalResult

```python
@dataclass
class GoalResult()
```

Defined in: [src/strands/vended\_plugins/goal/plugin.py:118](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/goal/plugin.py#L118)

Aggregate result of a goal run, exposed via `GoalLoop.last_result`.

## JudgeConfig

```python
@dataclass
class JudgeConfig()
```

Defined in: [src/strands/vended\_plugins/goal/plugin.py:127](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/goal/plugin.py#L127)

Tuning for the auto-built judge used when `goal` is a natural-language string.

Harmlessly ignored when `goal` is a validator function — no judge is built in that case.

**Attributes**:

-   `model` - Model the judge agent uses. Resolution order: this `model` > `agent.aux_model`
    
    > `agent.model` of the host agent.
    
-   `system_prompt` - System prompt for the judge agent. Defaults to JUDGE\_SYSTEM\_PROMPT.

## GoalLoop

```python
class GoalLoop(Plugin)
```

Defined in: [src/strands/vended\_plugins/goal/plugin.py:208](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/goal/plugin.py#L208)

Iterative-refinement plugin.

A single GoalLoop instance can be attached to multiple Agents; per-agent run state is keyed off the agent, so concurrent runs on different agents don’t interfere. Only one GoalLoop is supported per individual agent.

**Arguments**:

-   `goal` - What “done” means for this loop. Either a natural-language goal (str) judged by an internal Agent, or a programmatic validator callable.
-   `judge` - Tuning for the auto-built judge (ignored when goal is a callable).
-   `max_attempts` - Maximum number of attempts. Defaults to infinity.
-   `timeout` - Wall-clock budget for the whole run, in seconds. Defaults to infinity.
-   `name` - Plugin name. Defaults to ‘strands:goal-loop’.
-   `preserve_context` - Whether to preserve conversation history across retries. When True (default), the agent sees its own prior responses and feedback. When False, each failed attempt restores the agent’s session state to what it was immediately before the first model call.
-   `resume_prompt_template` - Builds the user message fed before each retry. Receives the trimmed validator feedback (or None). Override to localize or retune the framing.

#### \_\_init\_\_

```python
def __init__(
    goal: str | Validator,
    *,
    judge: JudgeConfig | None = None,
    max_attempts: int | float = float("inf"),
    timeout: float = float("inf"),
    name: str = "strands:goal-loop",
    preserve_context: bool = True,
    resume_prompt_template: Callable[[str | None], str | list[ContentBlock]]
    | None = None
) -> None
```

Defined in: [src/strands/vended\_plugins/goal/plugin.py:233](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/goal/plugin.py#L233)

Initialize the GoalLoop plugin.

**Arguments**:

-   `goal` - Natural-language goal string or programmatic validator callable.
-   `judge` - Tuning for the auto-built NL judge. Ignored when goal is callable.
-   `max_attempts` - Maximum number of attempts before stopping.
-   `timeout` - Wall-clock budget in seconds for the entire run.
-   `name` - Plugin name. Must be unique per agent.
-   `preserve_context` - Whether to keep conversation history across retries.
-   `resume_prompt_template` - Custom template for the retry user message.

#### name

```python
@property
def name() -> str
```

Defined in: [src/strands/vended\_plugins/goal/plugin.py:291](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/goal/plugin.py#L291)

Plugin name.

#### last\_result

```python
def last_result(agent: Agent) -> GoalResult | None
```

Defined in: [src/strands/vended\_plugins/goal/plugin.py:295](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/goal/plugin.py#L295)

Result of the most recent completed run on `agent`.

Returns None if no run has finished on that agent since this plugin was constructed, or if a run is still in-flight.

#### init\_agent

```python
def init_agent(agent: Agent) -> None
```

Defined in: [src/strands/vended\_plugins/goal/plugin.py:306](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/vended_plugins/goal/plugin.py#L306)

Register hooks on the agent. Called by the plugin registry.