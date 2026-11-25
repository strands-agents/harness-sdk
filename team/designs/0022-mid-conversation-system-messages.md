# Mid-conversation system messages

**Date**: 2026-10-16

**Related**: design 0021, cache friendly tool management ([#5161](https://github.com/strands-agents/harness-sdk/pull/5161)); [#5171](https://github.com/strands-agents/harness-sdk/pull/5171), retry with `drop_block`

**Scope**: Both Python & TypeScript

## Context

Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 tie each thinking block to everything sent before it: the system prompt, the tools and the earlier messages. If any of that changes, the API rejects the request or drops the thinking, and the prompt cache misses [R1] [R3].

Today the SDK catches that rejection and retries with `drop_block` ([#5171](https://github.com/strands-agents/harness-sdk/pull/5171)). Requests succeed, but the model loses its earlier thinking. In our test that cost 75% more output tokens, and the conversation cache was never read (Appendix A).

The SDK edits earlier content in a few places:

- `ContextInjector` and `MemoryManager` add text to the latest user message for one call, and leave it out on the next call. This design fixes the `ContextInjector` case, as an opt-in.
- The agentic context manager adds a `<context-status>` block to the last message for one call.
- Structured output adds a tool for one invocation and removes it afterwards.
- AgentSkills changes the system prompt when the list of skills changes.

Anthropic and AWS both say to append a `role: "system"` message instead of editing [R1 §Make changes without editing the prefix] [R2] [R7]. OpenAI's equivalent is the `developer` role [R4]. The SDK can't send either one, because `Role` is only `"user" | "assistant"`.

## Goal

Stop editing earlier messages, so preserved thinking and the prompt cache keep working. Give the SDK a native way to add instructions partway through a conversation.

- The conversation we send only grows at the end.
- Nothing breaks for existing users.
- Keep the change small, and pick an API we won't need to change later.

## What the APIs support

| API | Mid-conversation system message | Notes |
|---|---|---|
| Claude API | `role: "system"` | Treated as app instructions, above the user. Not for untrusted text such as tool output or documents. Sonnet 5.5 and Haiku 5.5 may ignore one right after a tool result. `clear_at` hides one after the next user message [R2] |
| Bedrock Messages API | `role: "system"`, on Opus 4.8 and the Claude 5 family | Same rules as the Claude API [R6] [R8] |
| Bedrock Converse | `system` is a valid role [R5], but our test with Claude rejected one as the last message | For OpenAI models, Converse moves `developer` messages into the top-level system field [R10] |
| OpenAI Responses and Chat Completions | `role: "developer"` | Ranks above the user [R4] [R9]. Accepted mid-conversation in our tests. No documented prefix check for reasoning |
| Gemini | None | The text has to go in a user message |

Claude's placement rule: a system message comes right after a user message (tool results count) or after an assistant message that ends in a server tool result. It's followed by an assistant message or is the last message [R2 §Limitations].

## Prior Art

How other agent frameworks handle this, as of October 2026:

| Framework | Mid-conversation system message | Thinking-binding error |
|---|---|---|
| LangChain | Native on Claude when the model profile sets `mid_conversation_system_messages` and the placement is valid. Otherwise hoisted into the top-level `system` field with a warning [R11] [R12]. In place on OpenAI. Hoisted on Bedrock Converse [R13] | Not handled in the core libraries |
| LiteLLM | Native on Claude models flagged in its model map. Otherwise, and on Bedrock Converse, it becomes a user message in place, starting with "Operator note (not from the user)" [R16] | Exposes `prefix_mismatch_behavior`. Its `/v1/messages` path retries once with the thinking removed [R16] |
| Vercel AI SDK | Off unless `allowSystemInMessages` is set. Native on Anthropic, in place on OpenAI. An error on Bedrock Converse and Gemini [R17] | Exposes the `drop_block` setting and `inputTransformations`. No retry [R17] |
| Pydantic AI | Native on supported Claude models, also through the Anthropic SDK's Bedrock and Vertex clients. In place on OpenAI. Elsewhere, a `<system>`-tagged user message [R18] | Retries once with `drop_block` and keeps it on, like #5171 [R18] |
| Mastra | Every system message is hoisted to the front [R19] | Not handled |
| OpenAI Agents SDK | In place on OpenAI. Other models go through LiteLLM [R20] | Not handled |
| Google ADK | Not supported. The runner turns every incoming message into a user message [R21] | Not handled. There's an open issue for this error [R21] |

Most of these put per-call context in the system prompt and rebuild it on every call: LangChain's `create_agent` [R15], the Vercel AI SDK's `instructions` [R17], Pydantic AI's instructions [R18], Mastra [R19] and the OpenAI Agents SDK [R20]. When that context changes, the prefix changes.

What we take from this:

- Use the native role where the API has one: `system` on Claude, `developer` on OpenAI.
- Where there's no native role, put the text in a user message in place, like LiteLLM and Pydantic AI. Don't hoist it: moving a system message into the top-level system field invalidates every thinking block in the conversation [R1 §Libraries, proxies, and gateways].
- `drop_block` keeps requests working, but it doesn't keep the thinking. Only appending does.

## Proposal

Add `"system"` as a third message role.

- The agent stores system messages in `agent.messages`, like any other message. Hooks see them and sessions save them.
- The code that adds context can write them: `ContextInjector`, interventions, steering and harness plugins. It's off by default in the SDK.
- Each model provider says whether it can send them natively. If it can, it sends them as its own role. If it can't, the SDK folds the text into the user message of that turn, the same way `ContextInjector` adds text today.

### Baseline

- Everything up to the model's last reply is sent the same way on every later request.
- Use the native role when the model has one: `system` on Claude, `developer` on OpenAI. For every other model, fold the text into a user message.
- Never move a system message into the top-level system prompt.
- What we store doesn't depend on the model. The same history works after a model switch.

### How it works

A system message holds text only:

```python
{"role": "system", "content": [{"text": "Auto-approve is on for file edits from now on."}]}
```

`developer` isn't an SDK role. It's how the OpenAI providers send a `system` message. Tool changes (`tool_addition`, `tool_removal`) are left for design 0021.

In these rules, a turn is the messages after one assistant message and before the next. The first turn starts at the beginning of the conversation, and the last turn runs to the end.

- **Adding.** A system message can only be added right after a user message or another system message. Tool results count as a user message. Adding one anywhere else, or with content other than text, raises a `ValueError`.
- **Sending.** In each turn, user messages go first and system messages go after them, each in the order they were added. This covers a user message added after a system message, such as a retry prompt or the next question after a failed call. The order changes only in the request. `agent.messages` and sessions keep the order the messages were added in.
- **Bad history.** If a turn has a system message but no user message, the SDK leaves the system message out of the request and logs a warning. Only direct writes to `agent.messages`, including `Agent(messages=...)`, can cause this.
- **No duplicates.** The built-in triggers run on every user turn (`userTurn`) or every model call (`everyTurn`). Today each injected copy is gone after one call, but a system message stays in history, so copies would pile up. With `as_system_message` on, `ContextInjector` skips the write when the text matches the last system message it wrote, and writes again if trimming removed it. For example, an injector that writes the date adds one system message per day, not one per turn. This follows Anthropic's advice to render context once and add a new version only when it changes [R1 §Make changes without editing the prefix].

Claude also allows a system message after an assistant message that ends in a server tool result. We leave that case out. `AnthropicModel` resumes paused turns inside one model call, so `agent.messages` never ends with one.

Two settings decide what happens:

| | `as_system_message` | `supports_system_messages` (Model capability property) |
|---|---|---|
| Lives on | `ContextInjector`, interventions `Guide`, steering | `Model` |
| Set by | The user. Default `False` (TS `asSystemMessage`) | The provider, for each model |
| Decides | Where injected text goes: the user message, or `agent.messages` as a system message | How a stored system message is sent to this model: native, or folded |

With `as_system_message=False`, injection works as today on every model.

### How it fits each provider

| Platform | Strands provider | A `system` message is sent as |
|---|---|---|
| Claude API | `AnthropicModel` | `role: "system"` on models new enough to support it, by version. Folded on older ones |
| Bedrock Messages API | None yet (open question 2) | `role: "system"` |
| Bedrock Converse | `BedrockModel` | Folded. On models that reject text next to a tool result ([#1223](https://github.com/strands-agents/harness-sdk/issues/1223)), as its own user message |
| OpenAI Responses and Chat Completions | Py `OpenAIResponsesModel` and `OpenAIModel`, TS `OpenAIModel` | `role: "developer"` on OpenAI's API and Bedrock. Folded with a custom base URL or client |
| Gemini, Ollama, llama.cpp, Mistral, Writer, LlamaAPI, Vercel, LiteLLM, SageMaker | Each provider | Folded |

### What it touches

**Major changes.** New behavior:

- **Message types.** `Role` adds `"system"`. The role in a model's streamed `messageStart` event gets its own `user | assistant` type, so it doesn't grow with `Role`.
- **Turn rules.** Checked when the agent adds a system message, and applied when it builds each request.
- **Capability and fold.** `Model.supports_system_messages`, and folding before every model call.
- **Native providers.** `AnthropicModel` and the OpenAI providers, in both SDKs, send `system` or `developer`.
- **`ContextInjector`.** New `as_system_message` option, default `False`, with no duplicates when it's on.
- **Interventions `Guide` and steering.** New `as_system_message` option for guidance to the model. Guidance on a tool call stays in the tool result.
- **Harness.** `EnvironmentContext` sends its `<environment>` block (platform, date, working directory) as a system message. The AGENTS.md text and the lists of nearby files stay in the user message, because they come from files in the workspace. The todos plugin stays in the user message too, because the model writes the todo list.

**Minor refactors.** These become role-aware, and behave the same until someone opts in:

- **Last-message reads.** Code that treats `messages[-1]` as the last user or assistant message looks for that role instead. This covers continuation input, guardrail redaction, interrupt and limit results, the TypeScript cancel path, and `<context-status>`. `<context-status>` goes on the last user message, after any folded text. In Python, session redaction updates the latest stored message, which can now be a system message, so it has to target the user message.
- **Injection triggers.** They ignore system messages at the end, so one injector doesn't block another injector's `userTurn` trigger.
- **`MemoryManager`.** Skips system messages when it builds a search query or extracts memories.
- **Conversation managers.** Sliding window, offload and pinning keep a system message with the user messages of its turn. They keep, drop or pin them together, and offload never shortens a system message.
- **Subagent fork.** Leaves out the parent's system messages.
- **Interventions `Guide` append (Python).** It adds messages with a plain `agent.messages.append`, so `MessageAddedEvent` doesn't fire. It moves to the agent's append path. This bug fix stands on its own.
- **Telemetry.** Python names message events `gen_ai.{role}.message`, so a system message would get the system prompt's name, `gen_ai.system.message`. TypeScript falls back to `gen_ai.message`. Both need a separate name for system messages.

**No change:**

- Sessions, snapshots and session repair store and restore messages as they are. Session repair keeps working, because a system message never sits between a tool call and its result.
- `MessageAddedEvent` and `InvokeModelContext` already carry every message.
- Continuation appends merge consecutive messages with the same role. Merged system messages are fine, since Claude reads consecutive system messages together [R2].
- `MemoryManager` keeps memories in the user message. Memories are untrusted.
- Structured output prompts, goal-loop resume and direct tool calls keep using user messages.
- The summarizing conversation manager writes its summary as a user message, so a system message at the start of the kept messages still follows one.
- The A2A client sends only the last user message from the input. System messages aren't sent, and we document that.
- AgentSkills, Swarm handoff and `<context-status>` could use system messages later. That's up to their owners.
- `bidi/` has its own `Role` and providers, and is out of scope.

### Trade-offs

Good:

- With `as_system_message` on, injected context stops editing earlier messages, so the thinking and the cache are kept.
- On Claude and OpenAI, app context is treated as coming from the app, not from the user.
- System messages only show up if you opt in or use the harness. Custom providers keep working.
- The same history works across models, so a router can switch models mid-conversation.
- It's the base for native tool changes (`tool_addition`) in design 0021.

Not so good:

- It's opt-in. Users of Claude models with preserved thinking who don't turn on `as_system_message` keep losing the thinking. #5171 keeps their requests from failing.
- `BedrockModel` folds for now, so Claude on Converse reads the text as user text. Native support needs the Messages API.
- Sonnet 5.5 and Haiku 5.5 may ignore a system message right after a tool result. That affects `everyTurn` injection in tool loops. `EnvironmentContext` writes after the user's own message, so it isn't affected. Our tests only used a harmless note, not one that conflicts with the user.
- Code that assumes two roles (`if role == "user" ... else ...`) can go wrong once someone opts in. We fix ours. Custom conversation managers, and UIs that show `agent.messages`, need to handle the third role.
- Without `clear_at`, a reminder with the same text shows up once, where it was first sent, not on every turn. Text that changes adds a new copy each time, and the copies stay in history.

## Developer Experience

```python
# Turn it on for an injector
agent = Agent(plugins=[ContextInjector(render, trigger="everyTurn", as_system_message=True)])

# Or add one yourself, after the user message
agent([
    {"role": "user", "content": [{"text": "Refactor the parser."}]},
    {"role": "system", "content": [{"text": "Auto-approve is now on for file edits."}]},
])
```

```ts
const agent = new Agent({
  plugins: [new ContextInjector({ renderContent: render, trigger: 'everyTurn', asSystemMessage: true })],
})
```

There's no new append API. Hooks add system messages through the agent's input or continuation messages, and both paths apply the turn rules.

A custom provider that sends system messages itself overrides one property:

```python
class MyModel(Model):
    @property
    def supports_system_messages(self) -> bool:
        return True
```

## Alternatives considered

- **Record and replay on every model.** The injector saves the text it sent, and resends it in the same user message on every later call. It keeps the thinking and the cache without a new role (Appendix A), but the model still reads app context as the user's words, and models that aren't broken today pay for the extra copies. The special-case option in open question 1 uses the same record, only on the affected models.

## Compatibility

Two repo rules decide what counts as breaking:

- Adding a member to a union isn't breaking ([COMPATIBILITY.md](../COMPATIBILITY.md) §Union Type Extensions).
- A change that only affects users who opt into something new can ship in a minor release ([FEATURE_LIFECYCLE.md](../FEATURE_LIFECYCLE.md) §Pay for Play).

| Change | Breaking? | Notes |
|---|---|---|
| Add `"system"` to `Role` | No | Union extension |
| `supports_system_messages`, off by default | No | Providers that don't turn it on get folded messages |
| Native sending on Anthropic and OpenAI | No | Only changes conversations that contain system messages |
| Turn rules, and the provider changes below | No | `"system"` isn't a valid role today. See the release note below |
| `as_system_message`, default `False` | No | Pay for play |
| Sessions that contain system messages | Pay for play | Older SDKs don't handle them. They only exist after an opt-in, or by default in the harness |
| Harness `EnvironmentContext` sends system messages | Allowed under the harness 0.x rule | The harness follows its own versioning rule [R14]. Called out in its release notes |
| `as_system_message=True` by default | **Yes** | `agent.messages`, sessions and UIs start seeing system messages. Optional, next major release only, with a migration guide |

Turning `as_system_message` on mid-conversation is fine: system messages are added from then on. Turning it off leaves earlier system messages where they are.

Release note. Some code already passes `role: "system"` messages, even though it isn't a valid role, and it works on some providers today. After this change:

- Adding a system message in a spot the rules don't allow raises a `ValueError`. For example, right after an assistant message.
- A system message at the start of `Agent(messages=...)` is sent after the first user message. Use `system_prompt` for instructions that apply to the whole conversation.
- Providers send a `system` message like this:

| Provider | Today | After |
|---|---|---|
| Anthropic (Py, TS) | Passed through as `system` | `system` on models that support it, folded on older ones |
| OpenAI Chat and Responses (Py) | Passed through as `system` | `developer` |
| OpenAI Chat (TS) | Sent as an assistant message | `developer` |
| OpenAI Responses (TS) | Sent as a user message | `developer` |
| Bedrock (Py, TS) | Passed through as `system` | Folded |
| Gemini | Sent as a model message (Py) or a separate user message (TS) | Folded |
| Vercel (TS) | Dropped | Folded |
| LiteLLM, SageMaker, Ollama, llama.cpp, Mistral, Writer, LlamaAPI (Py) | Passed through as `system` | Folded |

Out of scope: these still change earlier content, so they still lose the thinking and restart the cache.

- Structured output's per-invocation tool, AgentSkills when the skill list changes, sliding-window trims, and `<context-status>`.
- Untrusted text that can't go in a system message: `MemoryManager` memories, the harness todo list and the AGENTS.md text. They keep today's one-call injection, unless the team picks the special-case option in open question 1, which resends them in their original user message.

## Action Items

Each phase is one or more PRs. Python and TypeScript move together.

| Phase | Work | Effect on users |
|---|---|---|
| 1 | Core: the role, turn rules, capability and fold, last-message reads, the `Guide` append fix, telemetry | None. Nothing writes system messages yet |
| 2 | Consumers, with their owners: injection triggers, memory, conversation managers, subagent fork | None |
| 3 | Native providers: Anthropic, OpenAI Responses and Chat | System messages that users write are sent natively |
| 4 | Producers: `as_system_message` on `ContextInjector`, `Guide` and steering. The harness `EnvironmentContext` sends its `<environment>` block as a system message | Users who opt in, and harness users, get native system messages |
| 5 | Docs and release notes, including the provider table above | — |
| Next major, optional | `as_system_message=True` by default | See Compatibility |
| Later | Turn-scoped system messages, when a producer needs them | — |

Phases 1 to 3 ship in the same release, and a model's `supports_system_messages` value never changes after it ships. Otherwise earlier turns would be sent differently, and their thinking would no longer be valid.

Tests:

- **Request diffs, on every provider.** Each request starts with the previous request, byte for byte, across tool loops, retries, failed calls and session restore.
- **Turn rules.** Adding a system message in a bad spot raises. Requests put a turn's system messages after its user messages. A system message in a turn without a user message is never sent.
- **No duplicates.** With `as_system_message` on, an injector adds a system message only when its text changes, or when the old one was trimmed.
- **Live, with the check turned on** [R1 §Set the mismatch behavior and read input_transformations]. Include Sonnet 5.5 and Haiku 5.5 with a note that conflicts with the user.

### Later: turn-scoped system messages

Claude's `clear_at` hides a system message after the next user message [R2 §Turn-scoped system messages]. Pydantic AI already sends one this way for request-scoped instructions [R18]. It saves tokens on repeated reminders like `<context-status>`. It doesn't stop edits, and OpenAI has nothing like it, so it isn't part of this design.

If we add it, it has to be a field on the stored message, not a model or plugin setting. Changing `clear_at` on an earlier message counts as an edit [R2 §Rules for turn-scoped messages].

## Open questions

1. **Major decision, needs team alignment: what's the default?** The role, turn rules, fold and providers are the same in every option. Only the default changes.
   - **Special-case the affected models.** Providers mark the Claude models with preserved thinking through model capabilities. On those models, injectors record what they sent in `agent.state` and resend it on every later call. Trusted text goes as a `system` message, and untrusted text in its original user message. `agent.messages`, hooks and sessions don't change, and every other model keeps today's behavior. Because nothing users can see changes, this ships as a fix, like #5171.
   - **Break broadly and ship 2.0.** System messages become the default everywhere, and `as_system_message` goes away. It's the simplest design, but code that assumes two roles has to change.
   - **Keep backward compatibility.** This doc's proposal: system messages are opt-in with `as_system_message`, and the default can flip in a later major release.
2. **Claude on Bedrock.** `BedrockModel` uses Converse, which can't send a system message last, so it folds. Should native support come from `AnthropicModel` with the Anthropic SDK's Bedrock client, as LangChain and Pydantic AI do [R13] [R18], or from a Messages API mode in `BedrockModel`?

## References

- **[R1]** Anthropic, [Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
- **[R2]** Anthropic, [Mid-conversation system messages and tool changes](https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages)
- **[R3]** Anthropic, [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- **[R4]** OpenAI, [Text generation: message roles](https://developers.openai.com/api/docs/guides/text)
- **[R5]** AWS, [Bedrock Converse `Message`](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Message.html): `role` is `user`, `assistant` or `system`
- **[R6]** AWS, [Mid-conversation system messages (Bedrock Messages API)](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-mid-conversation-system.html)
- **[R7]** AWS, [Preserved thinking on Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-thinking-block-binding.html)
- **[R8]** AWS, [APIs supported by Amazon Bedrock](https://docs.aws.amazon.com/bedrock/latest/userguide/apis.html)
- **[R9]** OpenAI, [Model Spec](https://model-spec.openai.com/2025-12-18.html), "Definitions": `system` messages come from OpenAI, `developer` messages from the application developer
- **[R10]** AWS, [OpenAI models on Bedrock, request body](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-openai.html): Converse moves `developer` messages into the `system` array
- **[R11]** LangChain, [`ModelProfile.mid_conversation_system_messages`](https://github.com/langchain-ai/langchain/blob/master/libs/core/langchain_core/language_models/model_profile.py): absent or `False` means the model may move the message into the leading system prompt
- **[R12]** LangChain, [`langchain_anthropic/chat_models.py`](https://github.com/langchain-ai/langchain/blob/afafd55d34cb11b794781fd0f7bef9127c633f84/libs/partners/anthropic/langchain_anthropic/chat_models.py#L716-L761): sends a system message in place or hoists it, with `_warn_system_message_hoisted`
- **[R13]** LangChain, [`langchain_aws/chat_models/bedrock_converse.py`](https://github.com/langchain-ai/langchain-aws/blob/08b0d92553d8a37c46d1246960679204a76a0f5a/libs/aws/langchain_aws/chat_models/bedrock_converse.py#L1241-L1245) (Converse hoists, so the flag is off) and [`langchain_aws/chat_models/anthropic.py`](https://github.com/langchain-ai/langchain-aws/blob/main/libs/aws/langchain_aws/chat_models/anthropic.py) (`ChatAnthropicBedrock`)
- **[R14]** Strands, [Harness versioning](../../site/src/content/docs/user-guide/harness/versioning.mdx): the harness and CLI are 0.x and follow their own rule
- **[R15]** LangChain, [`create_agent`](https://github.com/langchain-ai/langchain/blob/afafd55d34cb11b794781fd0f7bef9127c633f84/libs/langchain_v1/langchain/agents/factory.py#L1502-L1504): puts the system message first on every model call
- **[R16]** LiteLLM, [`mid_conversation_system.py`](https://github.com/BerriAI/litellm/blob/2d181e66337393ed8fb2bbd85e56ced21308366c/litellm/litellm_core_utils/prompt_templates/mid_conversation_system.py#L8-L25) (native or "Operator note" user message) and [the `/v1/messages` retry](https://github.com/BerriAI/litellm/blob/2d181e66337393ed8fb2bbd85e56ced21308366c/litellm/llms/base_llm/anthropic_messages/transformation.py#L191-L212)
- **[R17]** Vercel AI SDK: [`allowSystemInMessages`](https://github.com/vercel/ai/blob/e0b96197ea1c1c51f8c49624d2879633d80ba5ba/packages/ai/src/prompt/standardize-prompt.ts#L87-L96), [Anthropic conversion](https://github.com/vercel/ai/blob/e0b96197ea1c1c51f8c49624d2879633d80ba5ba/packages/anthropic/src/convert-to-anthropic-prompt.ts#L230-L281), [Bedrock Converse error](https://github.com/vercel/ai/blob/e0b96197ea1c1c51f8c49624d2879633d80ba5ba/packages/amazon-bedrock/src/convert-to-amazon-bedrock-chat-messages.ts#L185-L191), [Gemini error](https://github.com/vercel/ai/blob/e0b96197ea1c1c51f8c49624d2879633d80ba5ba/packages/google/src/convert-to-google-messages.ts#L308-L314), [block binding setting](https://github.com/vercel/ai/blob/e0b96197ea1c1c51f8c49624d2879633d80ba5ba/packages/anthropic/src/anthropic-language-model.ts#L749-L754) and [`instructions` placement](https://github.com/vercel/ai/blob/e0b96197ea1c1c51f8c49624d2879633d80ba5ba/packages/ai/src/prompt/convert-to-language-model-prompt.ts#L57-L70)
- **[R18]** Pydantic AI: [native system messages](https://github.com/pydantic/pydantic-ai/blob/e0f61fa/pydantic_ai_slim/pydantic_ai/models/anthropic.py#L2335-L2341), [the `drop_block` retry](https://github.com/pydantic/pydantic-ai/blob/e0f61fa/pydantic_ai_slim/pydantic_ai/models/anthropic.py#L861-L887), [`clear_at` for request-scoped instructions](https://github.com/pydantic/pydantic-ai/blob/e0f61fa/pydantic_ai_slim/pydantic_ai/models/anthropic.py#L2537-L2549), [`<system>`-tagged user messages](https://github.com/pydantic/pydantic-ai/blob/e0f61fa/pydantic_ai_slim/pydantic_ai/models/__init__.py#L2820-L2845) and [instructions on every request](https://github.com/pydantic/pydantic-ai/blob/e0f61fa/pydantic_ai_slim/pydantic_ai/_agent_graph.py#L1906-L1910)
- **[R19]** Mastra, [`message-list.ts`](https://github.com/mastra-ai/mastra/blob/cc4b83ba3387bf991de93e44c1b2dfeea42afe83/packages/core/src/agent/message-list/message-list.ts#L1218): system messages go before all other messages
- **[R20]** OpenAI Agents SDK: [`developer` and `system` items in place](https://github.com/openai/openai-agents-python/blob/64cd5df/src/agents/models/chatcmpl_converter.py#L688-L701) and [`instructions` resolved on every turn](https://github.com/openai/openai-agents-python/blob/64cd5df/src/agents/run_internal/run_loop.py#L2839-L2842)
- **[R21]** Google ADK: [incoming messages become user messages](https://github.com/google/adk-python/blob/365084d/src/google/adk/runners.py#L1175-L1180) and [issue #7480](https://github.com/google/adk-python/issues/7480)

## Appendix _Stop reading_

### Appendix A - Live tests on the Claude API

Opus 5.5, raw Messages API. Two user turns, each with a tool loop. Adaptive thinking at medium effort. The check is turned on (`thinking.block_binding.prefix_mismatch_behavior: "error"`, beta `thinking-binding-controls-2026-08-01`), except in the "older account" row. One run each.

| Scenario | Result | Thinking kept | Conversation cache | Output tokens |
|---|---|---|---|---|
| Append-only baseline | 200 | Yes | Grows | 588 |
| Today's injection, check on | **400 on call 2** | — | — | — |
| Today's injection, older account | 200 | Not checked | Never read | 798 |
| Today's injection + `drop_block` | 200, 15 blocks dropped | No | Never read | 1,031 |
| Record and replay | 200, 0 dropped | Yes | Grows | 572 |
| System message with `clear_at` | 200, 0 dropped | Yes | Grows | 612 |
| System message | 200, 0 dropped | Yes | Grows | 533 |
| Tools list changes per invocation | 400: "The `tools` list differs" | — | — | — |
| `tool_addition` / `tool_removal` in a system message | 200, 0 dropped | Yes | Grows | — |

We also ran today's injection end to end through `Agent`, and it fails with the 400. Not tested yet: Fable 5.1, and a real account created after the cutoff.

### Appendix B - Live tests on Bedrock

Region `us-east-1`. Each test runs a tool loop and adds a note right after the tool result: "end your final answer with the exact token BATCH-42". A test passes if the request succeeds and the answer ends with the token. Claude tests have the check turned on. One run each, unless noted.

| API | Model | Message after the tool result | Result |
|---|---|---|---|
| Messages API | `global.anthropic.claude-opus-5-5` | `system`, two user turns | **Pass.** Thinking replayed with no `input_transformations` |
| Messages API | `global.anthropic.claude-sonnet-5-5`, `global.anthropic.claude-haiku-5-5` | `system`, two user turns, two runs each | **Pass** in all four runs. Harmless note only |
| Converse | `global.anthropic.claude-opus-5-5` | `system` as the last message | **Rejected:** "requires the last turn in the conversation to be a user message" |
| Converse | `global.anthropic.claude-opus-5-5` | `system` in the middle of the history | Accepted and followed |
| Chat Completions | `openai.gpt-oss-120b-1:0` | `developer` | **Pass** |
| Responses | `us.openai.gpt-5.6-terra`, `us.openai.gpt-6-astra` | `developer` | **Pass.** No reasoning items came back. These models need the inference profile ID |

### Appendix C - Live tests on OpenAI

Two user turns, each with a tool loop, and a developer message after every tool result asking for `BATCH-42`. Responses runs with `store: false` and replays every output item, reasoning included.

| API | Model | Result |
|---|---|---|
| Responses | `gpt-5.6-terra` | **Pass.** `reasoning.context` was `all_turns`, and the reasoning item replayed in turn 2 without error |
| Chat Completions | `gpt-5.6-terra` | **Pass** with `reasoning_effort: "none"`. With reasoning on, OpenAI rejects function tools on Chat Completions for this model |
