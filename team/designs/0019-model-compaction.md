# Model-side Compaction

**Date**: 2026-09-30

## Overview

Anthropic's newest models (Claude Opus 5.5, Fable 5.1, Sonnet 5.5) refuse to reuse a thinking block once anything sent before it has changed. Every way the SDK shrinks a long conversation today rewrites earlier messages, so on these models a long session eventually stops with a 400. Anthropic's replacement is *compaction*: the API writes the summary itself and returns it as a signed block that the model accepts as the new start of the conversation. This design adds that capability to the SDK, keeps our own summarizer as the fallback for providers that do not offer it, and fixes the fallback so it no longer leaves stale thinking behind.

## Problem

When an agent runs long enough to approach the context window, the SDK compresses history: it summarizes old turns into one message, drops the oldest turns, or truncates large tool results in place. All three edit messages the model has already seen.

On Opus 5.5 and later, each thinking block carries a signature bound to the exact system prompt, tool list, and messages that preceded it. If a later request differs anywhere before that block, the request is rejected:

```text
ValidationException: messages.1.content.0: Invalid `signature` in `thinking` block.
The block is bound to a different conversation. Remove the block, or set
`thinking.block_binding.prefix_mismatch_behavior` to "drop_block".
Content before this block was rewritten since it was created, first at `messages.0.content.0`.
```

The moment our context management kicks in, the conversation is dead. This affects anyone running a long agentic session on these models, and the harness is about to make Opus 5.5 the default. Today only Anthropic accounts created after 2026-08-31 are enforced by default, so most of the team does not see it yet; users on new accounts do.

### Current State

The SDK has three reduction paths, and all of them are affected.

1. **Summarization with a kept tail.** The `auto` context manager (at 85% utilization, keeping the four most recent messages), the agentic `summarize_context` tool, and the legacy `SummarizingConversationManager` all replace older turns with a summary we write ourselves and keep the recent turns verbatim. The kept turns still carry thinking blocks that were signed against the turns we just deleted. Verified live: this shape returns the 400 above every time.
2. **Dropping the oldest turns.** The `SlidingWindowConversationManager` removes messages from the front. Every later thinking block was signed against them. Verified: 400.
3. **Truncating tool results in place.** Also done by the sliding window on overflow, and by the offload strategies when `preserve_recent` is set. Rewriting a block the model already saw is the same class of edit.

One path is already safe and must stay that way: the `auto` preset truncates oversized tool results eagerly, at the moment the message is added and before it is ever sent. The model never sees the long version, so nothing it signed changes.

Two things are allowed by the API and verified to work: replacing history with the server's own signed compaction block and keeping the turns after it, or writing our own summary as long as we also strip every thinking block from the turns we keep.

## Proposal

We want a single place where "make this conversation shorter" is decided, that prefers the server's signed summary when the provider offers one, and otherwise falls back to our summary with the thinking removed.

Compaction does not have to cover the whole history. The API summarizes whatever messages are in the compaction request, so keeping recent turns means sending only the older prefix, then putting the returned block in front of the untouched tail. The cut must land at a valid trim point (after a tool result, or after an assistant turn that ended normally); the API rejects a prefix whose last assistant turn has an unanswered tool call. This maps directly onto today's `preserve_recent` configuration.

### Recommended: a `Model.compact()` capability, with the summary carried as a text block plus signature

Add an optional capability to the `Model` base class. Providers that cannot compact return `None`, which is also what a provider returns when the API produced no summary (for example the summarizer hit `max_tokens`).

```python
class Model:
    @property
    def supports_compaction(self) -> bool:
        return False

    async def compact(
        self,
        messages: Messages,
        *,
        system_prompt: SystemPrompt,
        tool_specs: list[ToolSpec],
        instructions: str | None = None,
    ) -> Message | None:
        """Ask the provider for a signed summary of `messages`. None if unsupported or no summary was produced."""
        return None
```

The summary itself is stored as an ordinary text block that additionally carries the server's signature. No new block type is introduced.

```python
{"role": "assistant", "content": [{"text": "<summary>", "signature": "EuYBCkQY..."}]}
```

Every provider except Anthropic already reads `text` and ignores other keys, so they render the summary as plain text with no changes. Only `AnthropicModel` needs one branch: a text block carrying a signature goes out as a `compaction` block, and its presence anywhere in history adds the `compact-2026-09-04` beta header. Because that is derived from the messages about to be sent, it survives session restore without extra state.

Every reduction path — the offload summarize strategy, the agentic tool, and the legacy manager — calls the capability first and falls back to the existing summarizer:

```python
summary = await agent.model.compact(older, system_prompt=..., tool_specs=..., instructions=...)
if summary is None:
    summary = await generate_summary(older, ...)        # existing client-side path
    strip_reasoning(kept_tail)                          # the one edit the API allows
messages[:split] = preserved + [summary]
```

**Pros:** one decision point shared by all three reduction paths; keeps reasoning across compaction on Anthropic; works for every other provider through the fallback; zero changes to other provider formatters; no session or model state beyond the messages themselves.

**Cons:** a text block that one provider turns into something else is slightly dishonest as a type, and any future code that merges or rewrites text blocks could drop the signature silently (the result is a quiet fall back to the client summary, not an error). On Bedrock the capability only works through the Messages API (`InvokeModel`), because Converse rejects compaction; Bedrock users get the fallback until `BedrockModel` has that transport.

### Alternative: a distinct `compaction` content block

Mirror the wire format with its own block type in both SDKs.

```python
class CompactionBlock(TypedDict):
    content: str
    signature: str
```

Unknown blocks make most provider formatters raise today, but every message already passes through one normalization step before any provider sees it; rewriting `compaction` to `text` there for models without `supports_compaction` means no provider file changes either.

- **Pros:** the type says what it is; a merge or rewrite cannot mistake it for user text.
- **Cons:** a new key in the `ContentBlock` union and TS class, plus streaming reconstruction for a block that arrives whole, for a value only one provider ever reads.

### Alternative: let the server compact automatically (threshold compaction)

Anthropic also offers compaction that happens *inside* a request: the caller sets a `context_management` edit with an input-token trigger, and when it is crossed the reply arrives with a compaction block in front of it. The SDK would only need to keep that block in history, send the header, and sum `usage.iterations` for cost.

- **Pros:** almost no SDK surface; the server owns the budget; no extra round trip.
- **Cons:** the trigger must be at least 50,000 tokens, so it cannot replace our utilization logic for smaller windows; it fights our own reduction unless we disable it; it cannot be combined with server-side tool-result clearing on the same request; and it exists only on Anthropic direct and Bedrock InvokeModel. Worth supporting as a passive mode later, not as the design.

### Alternative: delete client-side summarization

Server compaction is Anthropic's stated replacement for client compaction, so we could remove ours.

- **Cons:** it would leave OpenAI, Gemini, Ollama and Bedrock Converse users with no way to shrink a conversation. The fallback in the recommended option is a dozen lines; keeping it costs nothing.

## Developer Experience

Nothing changes for a `create_harness()` user. Long sessions on Opus 5.5 keep working and keep their reasoning across the compaction; on other providers they keep working as before, minus the stale thinking. Anyone who inspects `agent.messages` after a compaction sees the summary as an assistant message with one text block instead of today's user-role text.

Custom instructions flow through the existing summarization configuration and are passed to the server when it does the work:

```python
agent = Agent(
    model=AnthropicModel(model_id="claude-opus-5-5"),
    context_manager=ContextManager(
        strategies=[
            Offload.summarize("*", instructions="Keep file paths, commands run, and the todo list.")
                   .when(utilization=0.85, preserve_recent=4)
        ]
    ),
)
```

Model authors opt in by overriding two members:

```python
class MyModel(Model):
    @property
    def supports_compaction(self) -> bool:
        return True

    async def compact(self, messages, *, system_prompt, tool_specs, instructions=None) -> Message | None:
        ...
```

Edge cases: if the API returns no summary (`max_tokens`, `refusal`, `tool_use`, a dangling tool call), `compact()` returns `None` and the fallback runs, so the conversation never gets stuck. Cost tracking should read `usage.iterations`, because Anthropic reports the compaction call there and not in the top-level token counts; the SDK will surface a `compaction_iterations` metric.

## Additional Details

<details>
<summary>How Anthropic handles compaction</summary>

You send the conversation as it stands with `compaction: {"type": "summarize"}`, the same system prompt, tools and thinking settings as the real conversation, and the `compact-2026-09-04` beta. No reply is generated; the response is a single block with `stop_reason: "compaction"`. The summarizer reads the whole conversation, earlier thinking included (on 5.1-and-later models only when no custom instructions are given).

```json
{
  "role": "assistant",
  "content": [{ "type": "compaction", "content": "<summary>", "signature": "EuYBCkQY..." }],
  "stop_reason": "compaction",
  "usage": { "input_tokens": 0, "output_tokens": 0,
             "iterations": [{ "type": "compaction", "input_tokens": 2930, "output_tokens": 1313 }] }
}
```

You replace the summarized messages with that assistant message and keep any turns after it unchanged. This is the one sanctioned way to edit earlier history: the checked prefix restarts at the most recent compaction block, and thinking from before it is gone. Changing the block's text or signature returns `compaction_signature_invalid` or `compaction_content_mismatch`; sending it back with fields the API did not return is a validation error; omitting the header makes it an unknown block type. The kept tail's thinking stays valid as long as system and tools match what the summarizer saw. The call is billed but reported only in `usage.iterations`. If no summary was produced, the response is a 200 with empty content and the summarizer's own stop reason.

</details>

<details>
<summary>What was verified live</summary>

All runs on 2026-09-29 against `global.anthropic.claude-opus-5-5` in us-east-1 with binding enforcement opted in (`block_binding.prefix_mismatch_behavior = "error"`), so results are deterministic regardless of account age.

| History edit after a 3-turn tool loop with thinking in every turn | Result |
|---|---|
| Unchanged | OK |
| Client summary replaces turns 0–4, last assistant turn kept with its thinking | 400 "rewritten since it was created" |
| Same, thinking stripped from the kept turn | OK |
| Oldest user/assistant pair dropped | 400 "missing from this request" |
| Server compaction of turns 0–4 (Bedrock InvokeModel), then compaction block + kept tail | OK |
| Same follow-up without the `compact-2026-09-04` header | 400, unknown block type |
| Compaction through Bedrock Converse | 400 "The compact beta feature is not currently supported on the Converse and ConverseStream APIs" |

Anthropic's compatibility list names the Claude API, "Claude Platform on AWS", Google Cloud and Foundry; Amazon Bedrock is not listed, but InvokeModel accepted it. A related, prefix-safe server-side option that does work on Converse is `context_management` with `clear_tool_uses`, which clears old tool results without the client editing anything.

</details>
