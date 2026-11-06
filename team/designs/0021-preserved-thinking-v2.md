`# Preserved Thinking Compatibility

**Date**: 2026-10-14

**Issue**: [#4933](https://github.com/strands-agents/harness-sdk/issues/4933)

**Scope**:

## Overview

Anthropic has introduced preserved thinking with its latest models, Claude Fable 5.1 and Claude Opus 5.5 (see tests in appendix). When calling these models over `InvokeModel` or `Converse`, Anthropic will check that any thinking block has the system prompt, the tools list, or the chat history remain the same turn over turn. If one of these elements is edited by the Strands Agents SDK, more specifically the context manager, then Anthropic returns a 400 error. Additionally, users can enable `drop_block` which will then silently drop the thinking blocks. In the Strands harness the default conversation manager uses a Summarizer when the context window becomes too large, this will fail without further changes in the SDK.  

## Problem

<!-- > In a few sentences, what is the issue motivating this change? Extended background belongs in Additional Details. (200 words) 
>
> - What task are you trying to accomplish?
> - What makes it difficult or impossible today?
> - Who experiences this problem? -->

Anthropic's preserved thinking changes affect the way the context management can be accomplished in the Strands Agents SDK. Strands Agents SDK provides customers with context management techniques to reduce and reform the content in the agent's context window. The `SlidingWindowConversationManager` and `SummarizingConversationManager` utilize a `reduce()` method to summarize the context. Strands agents allows for editing `agent.system_prompt` between turns. Strands Agents also allows a tool result the model has already seen to be truncated or offloaded via other strategies. With preserved thinking enabled on the model, Anthropic will return a 400 error if any content in any of the thinking blocks is edited between turns. 

### Current State
<!-- 
> Now show *how* it's hard. Ground the reader in the existing system — how it works today and exactly where it falls short — before proposing to change it. (200 words)
> 
> - How is this handled now — the current API, flow, or workaround?
> - What concretely breaks, and where? Use examples, error messages, or numbers where you can.
> - What are the paper cuts — the small, recurring frictions that add up — not just the outright failures?
> - How often does this come up, and how costly is it when it does? -->

![Preserved Thinking Current Behavior](./assets/PreservedThinkingCurrentBehavior.png)

Strands treats `agents.messages` as editable. All context management strategies implemented in Strands, rely on this. The sequenc diagram abopve traces an agent running over three turns. The first and second turn only append to the messages. When the model uses thinking on the server-side, the model generates a thinking block. These thinking blocks are tied to the system prompt, the tool list, and every message in the history. The prefix includes the system prompt, the tools list, and the conversation history. The sequence diagram shows what happens currently when Strands is used to edit the prefix: 

- `SlidingWindow`, trims oldest messages once messages > 40 (default behavior)
- `Offload.summarize`, summarizes a prefix from the Strands side (client side)
- `_truncate_tool_results` and `EmergencyTruncateStrategy` rewrite or drop content the model has already seen.
- User code changes agent.system_prompt or the tools between invocations.

Each of these returns a 400 on turn 3 against `claude-opus-5-5` on Bedrock:


## Proposal

### Part 1: Using Claude Native API for Summarizing


There will be some new fields implemented on the Model class

```python
# strands-py/src/strands/models/model.py
class BaseModelConfig(TypedDict, total=False):
    context_window_limit: int | None
    preserved_thinking: bool | None  # overrides the defaults table keyed by model ID


class Model(abc.ABC):
    @property
    def preserved_thinking(self) -> bool:
        """Resolved as the preserved_thinking config key > the defaults table by model ID > False."""

    @property
    def supports_compaction(self) -> bool:
        """Whether the provider can call Claude's compaction API."""
        return False

    @property
    def supports_context_editing(self) -> bool:
        """Whether the provider can send clear_tool_uses context edits."""
        return False


# strands-py/src/strands/models/anthropic.py
class AnthropicModel(Model):
    @property
    def supports_compaction(self) -> bool:
        return True

    @property
    def supports_context_editing(self) -> bool:
        return True
```

Only `preserved_thinking` is user-settable config. `supports_compaction` and `supports_context_editing` are read-only provider properties, because they depend on the provider's transport: `BedrockModel` (Converse) rejects both, so letting users set them would only produce 400s.

```python
# Override the defaults table, e.g. for a new model ID the table doesn't know yet
model = AnthropicModel(model_id="claude-opus-5-5", max_tokens=8192, preserved_thinking=True)
```

When an agent is initialized, a context reduction strategy is determined from the three flags that have been added to the model class:

- Native: `preserved_thinking` and `supports_compaction` are true on the current model (`supports_context_editing` would be false here).
- Eager: When a model has `supports_context_editing`, Strands can freely edit the context without issues (This is behavior prior to preserved thinking changes)
- Strip: If a model has `preserved_thinking` and does not have `supports_compaction` or `supports_context_editing`, then `drop_block` needs to be used to drop thinking blocks 

![Preserved Thinking Current Behavior](./assets/PreservedThinkingProposalDeli1.png)

The previous diagram shows how one context reduction will be handled going forward. On `BeforeModelCallEvent`, the context manager calls the strategy's `apply()`.

In native mode, `SummarizeStrategy` splits the history at a valid prefix boundary. The split keeps `preserve_recent` messages, stops before pinned content, and never separates a `tool_use` from its result. The strategy then calls `AnthropicModel.compact()` on that prefix. Claude returns a signed compaction block, which replaces the prefix in a user message. The retained tail is unchanged, so its thinking blocks still pass the prefix check and the next request keeps its reasoning.

Eager mode is how the SDK currently behaves. This is when `MessageAddedEvent` triggers tool-result truncation before the model sees a tool result, so the history is unchanged. TODO: test this

In strip mode the strategy summarizes or drops as it does today, then calls `_strip_reasoning` from the edit index to the end. Strip mode covers BedrockModel (Converse), which supports neither API, and any pass where `compact()` returns None. The request no longer fails, but the stripped reasoning is lost.

Tool-result drops never touch `agent.messages` in native mode. `DropStrategy` registers a `ClearToolUsesEdit`, which the event loop passes to `stream()` on every request. `AnthropicModel` sends it as `clear_tool_uses_20250919`, and the server clears the old results without counting it as a history edit.


### Part 2: Everything Else?  


## Developer Experience
<!-- 
> Show what the developer experience looks like for the recommended option. (200 words)

> - Code examples showing typical usage
> - Configuration or setup required
> - Error messages and edge cases -->

The following is a flow chart showing how each time an agent is run, the context management strategy will be determined, so Strands can use the correct API for modifying the context. 

![Proposed Context Strategy](./assets/PreservedThinkingContextManagementStrat.png)


## Open Questions
- Should we log when a thinking block is noticed in the prefix/context, then start to check that the prefix is unchanged from the last turn? 

## Additional Details

<!-- > (Optional) Use for extended context that doesn't fit above: deep-dive investigations, longer prior-art surveys, or supplementary diagrams. Wrap it in a `<details>` block so the design stays scannable by default. -->

<details>
<summary>Opus 5.5 and Fable 5.1 errors</summary>

<!-- Extended content here -->

I believe just adding a whitespace to the system prompt does not trigger the 400 error because of a system prompt change. I have checked this script with the sonnet 5.5 model and anthropic doesn't enforce no-history-edits with this model. 

This file is some helper functions to run agents with different context configurations for easy testing. 

```python
import json

from strands import Agent, tool
from strands.agent.conversation_manager import (
    NullConversationManager,
    SlidingWindowConversationManager,
    SummarizingConversationManager,
)
from strands.hooks import BeforeModelCallEvent
from strands.models import BedrockModel


@tool
def get_weather(city: str) -> str:
    """Get the current weather for a city.

    Args:
        city: City name.
    """
    return json.dumps({"city": city, "temp_f": 61, "conditions": "overcast"})


@tool
def get_time(city: str) -> str:
    """Get the current local time for a city.

    Args:
        city: City name.
    """
    return json.dumps({"city": city, "local_time": "14:05"})


def make_agent(conversation_manager=None, mismatch_behavior="error"):
    model = BedrockModel(
        model_id="global.anthropic.claude-opus-5-5",
        region_name="us-west-2",
        max_tokens=8000,
        additional_request_fields={
            # Setting the field (any value) opts accounts created before 2026-08-31 into enforcement.
            "thinking": {"type": "adaptive", "block_binding": {"prefix_mismatch_behavior": mismatch_behavior}},
            "anthropic_beta": ["thinking-binding-controls-2026-08-01"],
        },
    )
    return Agent(
        model=model,
        tools=[get_weather],
        system_prompt="You are a terse weather assistant. Always use the get_weather tool.",
        conversation_manager=conversation_manager or NullConversationManager(),
        callback_handler=None,
    )
```
When the agent's model uses thinking is the only time that these can return an error, because when thinking blocks are included is when the Claude API will check the history to ensure it is unedited when thinking blocks are present. Thinking is enabled on Haiku 5.5, Sonnet 5.5, Opus 5.5, and Fable 5.1. 

Each scenario runs two turns, edits the history, then runs a third turn:

```python
# Baseline: append-only history -> 200
agent = make_agent()
agent("Weather in Seattle?"); agent("And Portland?"); agent("And Boise?")

# SlidingWindowConversationManager trims turn 1 -> 400
# "Content that preceded this block ... is missing, starting at `messages.0`"
agent = make_agent(SlidingWindowConversationManager(window_size=4))
agent("Weather in Seattle?"); agent("And Portland?"); agent("And Boise?")

# SummarizingConversationManager summarizes and keeps a tail -> 400
# "Content before this block was rewritten since it was created"
agent = make_agent(SummarizingConversationManager(summary_ratio=0.5, preserve_recent_messages=4))
agent("Weather in Seattle?"); agent("And Portland?")
agent.conversation_manager.reduce_context(agent)
agent("And Boise?")

# System prompt changed between turns -> 400
# "The `system` prompt differs from the one this block was created with"
agent = make_agent()
agent("Weather in Seattle?"); agent("And Portland?")
agent.system_prompt += " Answer in Celsius."
agent("And Boise?")

# Earlier tool result rewritten in place -> 400
# "Content before this block differs from when it was created"
agent = make_agent()
agent("Weather in Seattle?"); agent("And Portland?")
first_result = next(b for m in agent.messages for b in m["content"] if "toolResult" in b)
first_result["toolResult"]["content"] = [{"text": "[truncated]"}]
agent("And Boise?")

# Tool added between turns -> 400
# "The `tools` list differs from the one this block was created with."
agent = make_agent()
agent("Weather in Seattle?"); agent("And Portland?")
agent.tool_registry.process_tools([get_time])
agent("And Boise?")

# Thinking stripped from the in-progress tool-loop turn -> result unknown (open question 11)
# Runs before the call that continues the tool loop, after the tool result is appended.
def strip_in_progress_turn(event: BeforeModelCallEvent) -> None:
    messages = event.agent.messages
    if len(messages) < 2 or not any("toolResult" in block for block in messages[-1]["content"]):
        return
    messages[-2]["content"] = [block for block in messages[-2]["content"] if "reasoningContent" not in block]

agent = make_agent()
agent.add_hook(strip_in_progress_turn)
agent("Weather in Seattle?")

# Same trim as the sliding window, with drop_block -> 200 (reasoning dropped)
agent = make_agent(SlidingWindowConversationManager(window_size=4), mismatch_behavior="drop_block")
agent("Weather in Seattle?"); agent("And Portland?"); agent("And Boise?")
```


</details>


<details>
<summary>Testing Proposed Fixes Will Run</summary>

<!-- Extended content here -->


Need to test native mode stuff works
Need to test eager mode stuff works
Need to test strip mode stuff works

</details>

<details>
<summary>Unit tests that should pass once changes are implemented</summary>

<!-- Extended content here -->


Need to test native mode stuff works
Need to test eager mode stuff works
Need to test strip mode stuff works

</details>`