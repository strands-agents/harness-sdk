Dogwood Authorization evaluates a [Dogwood](https://github.com/dogwood-policy/dogwood) policy set before each tool call. Dogwood is Cedar with temporal conditions, so a policy can decide based on what the agent already did in this session, not only on the call in front of it. Approve a refund after a fraud check ran. Allow a delete once the record was read.

For access control that depends only on the current call, use [Cedar Authorization](/docs/user-guide/sdk/agents/interventions/cedar-authorization/index.md) instead. It has no wasm peer dependency and both SDKs support it.

## How it works

The handler spans both halves of a tool call. Before the call it submits a `request` event and enforces the verdict. After the call it records a `response` event, or an `error` event if the tool threw, which is what later temporal rules match against.

| Dogwood concept | Maps to | Example |
| --- | --- | --- |
| **Principal** | User identity | `User::"alice"` |
| **Action** | Tool name | `Action::"search"` |
| **Resource** | The agent itself | `Resource::"agent"` |
| **context.input** | Tool arguments | `{ query: "quarterly report" }` |
| **Event history** | Calls and results so far | `formerly within 1h …::response{}` |

A generated schema declares its actions and entities at the top level, so policies name `Action::"search"` and the default principal is `User::"anonymous"`. Pass `namespace: 'Acme'` to declare them under your own domain instead, which every rule then qualifies as `Acme::Action::"search"`. A hand-written `actionSchema` declares its own namespace, so the option is only valid with `tools`.

Policies are default deny: a tool with no matching `permit` is blocked, and the agent receives the denial reason as feedback.

## Basic usage

```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { DogwoodAuthorization } from '@strands-agents/sdk/vended-interventions/dogwood'
import { z } from 'zod'

const dogwood = new DogwoodAuthorization({
  policies: 'permit(principal, action == Action::"search", resource);',
  tools: [searchTool, deleteTool],
})

const agent = new Agent({
  tools: [searchTool, deleteTool],
  interventions: [dogwood],
})

await agent.invoke('Search for quarterly reports, then delete record 42')
// search runs; delete_record is denied because no permit matches it
```

Passing `tools` generates the Cedar action schema from your tool specs, and the constructor type-checks the policy set against it. A misspelled tool name, in a `permit` or inside a temporal predicate, throws immediately rather than leaving the rule silently unenforced. Pass `actionSchema` instead when you maintain the schema yourself.

Generated action ids are the tool names verbatim, so every tool name must be a legal Cedar identifier. A name containing `-`, `.`, or a space fails schema generation and throws.

A hand-written `actionSchema` must declare the entity types the handler actually sends: `Resource` for the resource, which is always `Resource::"agent"` under whatever namespace the schema declares, and `User` for the default principal. A policy that names an entity type the schema does not declare fails validation in the constructor.

A condition compares the tool arguments as the model emitted them, and a generated schema is typed to match: write `context.input.method == "DELETE"` for a `z.enum()` parameter and `context.input.retries > 3` for a `z.number()` one. A misspelled value is just another string, so it fails to match rather than failing to compile.

Reading a parameter the tool does not mark required needs a `has` guard, `context has input.retries && context.input.retries == 3`, or the constructor throws. A `z.number()` parameter is declared as a whole number, so comparing a fractional argument with `<`, `>`, `<=`, or `>=` is an evaluation error and denies the call. Equality is unaffected: `== 3` simply does not match `3.5`. See the [Dogwood language reference](https://github.com/dogwood-policy/dogwood) for the full type rules.

## Rules that depend on history

`when temporal` conditions match against the event history the handler accumulates:

```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { DogwoodAuthorization } from '@strands-agents/sdk/vended-interventions/dogwood'
import { z } from 'zod'

const dogwood = new DogwoodAuthorization({
  policies: `
    permit(principal, action == Action::"search", resource);

    permit(principal, action == Action::"delete_record", resource)
    when temporal {
      formerly within 1h Action::"search"::response{}
    };
  `,
  tools: [searchTool, deleteTool],
})

const agent = new Agent({
  tools: [searchTool, deleteTool],
  interventions: [dogwood],
  // The default concurrent executor decides every call in a turn before recording
  // any result, so the rule above would not see the search when the model emits
  // both calls at once.
  toolExecutor: 'sequential',
})

// Denied: nothing has been searched yet in this session
await agent.invoke('Delete record 42')

// Permitted: the search completed less than an hour ago
await agent.invoke('Find record 42, then delete it')
```

Match on `response` events for rules that mean “this already happened and finished”, and on `error` events for “this failed”. Dogwood records an event into history before deciding it, so a rule written against `request` events also matches the call being decided and satisfies itself on the first call.

A rule that unlocks one tool with another’s `response` needs the calls ordered. The default concurrent tool executor decides every call in a turn before recording any result, so the rule above does not fire when the model emits both calls at once. Set `toolExecutor: 'sequential'` on the agent, as the example does, and each call is decided after the previous one has been recorded.

Each recorded event carries the action, the principal, and the tool’s arguments, so a temporal predicate can key on an argument, as in `response{ input.query: "audit" }`. It does **not** carry the tool’s return value: a predicate on a result field, such as `response{ output.hits: 0 }`, type-checks cleanly against a tool that declares an `outputSchema` and then never matches, so the rule looks enforced and silently is not. The same holds for the `requestId` and `sessionId` fields the default event schema declares. Write `response{}` or `error{}`, optionally narrowed by `input.*`.

Dogwood itself supports result-keyed rules; this handler not recording `output` is the limitation, because a tool result is arbitrary content rather than a value shaped like the declared `outputSchema`.

An `error` event is recorded only when the tool threw. A result that merely carries an error *status* records nothing at all, because that is also how the executor reports a call a later handler blocked. A tool that catches its own failure and returns an error result, including an MCP tool returning `isError: true`, leaves no event in the history.

## Identity and session fields

Multi-tenant agents resolve the principal per request, and policies often need fields the tool arguments do not carry:

```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { DogwoodAuthorization } from '@strands-agents/sdk/vended-interventions/dogwood'
import { z } from 'zod'

const dogwood = new DogwoodAuthorization({
  policies: `
    permit(principal, action, resource)
    when { context.session.role == "admin" };

    permit(principal, action == Action::"search", resource)
    when { context.session.role == "analyst" };
  `,
  tools: [searchTool, deleteTool],
  principalResolver: (state) =>
    state.userId ? { type: 'User', id: String(state.userId) } : undefined,
  contextEnricher: ({ invocationState }) => ({
    role: String(invocationState.role ?? 'none'),
  }),
})

const agent = new Agent({
  tools: [searchTool, deleteTool],
  interventions: [dogwood],
})

await agent.invoke('Delete record 42', {
  invocationState: { userId: 'alice', role: 'admin' },
})

// Denied: an analyst may only search
await agent.invoke('Delete record 42', {
  invocationState: { userId: 'bob', role: 'analyst' },
})
```

`contextEnricher` adds fields to the `session` group of the request context, which a policy reads as `context.session.<field>`. Those fields reach the `when { … }` condition only, because the event schema declares a tool’s arguments and nothing else, so a temporal predicate cannot reference an enriched field.

Correlating history by principal needs no enricher. Every temporal predicate is pinned to the principal being decided, so one handler instance serves many users without their histories mixing: a search alice ran never unlocks a delete for bob.

When `principalResolver` returns `undefined`, the handler denies the call. No identity, no access.

A generated schema declares `User` as its only principal type, qualified by `namespace`, so a resolver returning any other type denies the call and a static `principal` of another type throws at construction. An undeclared type is not an error to Dogwood: a rule that scopes the principal simply never matches, so a `forbid` would silently not apply.

## Policies in files

`policies` and `actionSchema` each take either source text or a path. A value ending in `.dw` or `.cedarschema` is read from disk:

```typescript
import { DogwoodAuthorization } from '@strands-agents/sdk/vended-interventions/dogwood'

const dogwood = new DogwoodAuthorization({
  policies: './policies/agent.dw',
  actionSchema: './policies/agent.cedarschema',
})
```

The extension is what selects file over text, so a path with any other suffix is read as source and fails to parse rather than reporting a missing file.

Files are read, parsed, and validated in the constructor. There is no re-read at runtime, so an edited policy file takes effect the next time the handler is constructed.

## History and memory

History is never pruned, at roughly 1.7 KB per event in wasm. `reset()` drops it and keeps the handler deciding:

```typescript
import { Agent, tool } from '@strands-agents/sdk'
import { DogwoodAuthorization } from '@strands-agents/sdk/vended-interventions/dogwood'
import { z } from 'zod'

// One agent per session, because reset() clears every principal's history
const dogwood = new DogwoodAuthorization({
  policies: 'permit(principal, action == Action::"search", resource);',
  tools: [searchTool],
  principal: { type: 'User', id: 'alice' },
})

const agent = new Agent({ tools: [searchTool], interventions: [dogwood] })

await agent.invoke('Search for quarterly reports')

// The session is over: forget what the agent did, keep the policy set
dogwood.reset()
```

Calling `reset()` means holding the handler in a variable, as the example does, rather than constructing it inline in the `interventions` array: an agent exposes no way to reach an intervention back once it is built.

`reset()` clears every principal the instance has decided for, not one user’s history. A multi-tenant handler that resets when one session ends discards everyone else’s, and interventions are fixed at construction, so isolating histories means one agent per session rather than one handler per session.

History lives in memory only. It does not survive a process restart, and it is not part of an agent’s session state, so a resumed conversation starts with an empty history and a rule waiting on an earlier call will not fire.

## When a decision fails closed

Dogwood forces a deny on any evaluation error and clears the determining rules, so an error means something went wrong rather than the policy saying no. The handler reports the two cases with different denial reasons.

Tool arguments come from the model, so a request event can be malformed by a prompt. A decision that throws is treated as no decision and denies. A wasm trap denies that call and every call after it, since a trapped module cannot be trusted to decide anything.

`onError` controls what happens when the handler itself throws, for example when `principalResolver` raises:

-   `'throw'` (default): rethrows to the caller
-   `'deny'`: treats the failure as a denial
-   `'proceed'`: runs the tool with no authorization check

Fail-open on handler errors

With `'proceed'`, an exception from your resolver or enricher lets the tool call run unchecked. Use `'deny'` when the agent relies on Dogwood to enforce access. A failed Dogwood decision denies regardless of this setting.

## Installation

Dogwood evaluation runs in wasm through an optional peer dependency:

```bash
npm install @strands-agents/sdk @aws/dogwood-wasm
```

The handler imports `@aws/dogwood-wasm` at module load, so the import throws when the package is missing. The module is about 9.4 MB on disk (2.9 MB gzipped).

[Dogwood](https://github.com/dogwood-policy/dogwood)’s authors describe the implementation as a reference interpreter rather than a production one, and the wasm bindings inherit that, so treat this handler as experimental.

## Dogwood policy syntax

For the temporal operators, information providers, and event schema DSL, see the [Dogwood language reference](https://github.com/dogwood-policy/dogwood).

## Related pages

- [Cedar Authorization](/docs/user-guide/sdk/agents/interventions/cedar-authorization/index.md) (3 shared tags)
- [Approve before your agent acts](/docs/user-guide/sdk/agents/approve-before-acting/index.md) (2 shared tags)
- [Human in the loop](/docs/user-guide/sdk/agents/interventions/human-in-the-loop/index.md) (2 shared tags)
- [Interventions](/docs/user-guide/sdk/agents/interventions/index.md) (2 shared tags)
- [Creating a Custom Model Provider](/docs/user-guide/sdk/model-providers/custom_model_provider/index.md) (1 shared tag)
- [Run tools in the background](/docs/user-guide/sdk/tools/background-tasks/index.md) (1 shared tag)
- [Attack strategies](/docs/user-guide/evals-sdk/red-teaming/strategies/index.md) (1 shared tag)
- [Harmfulness evaluator](/docs/user-guide/evals-sdk/evaluators/harmfulness_evaluator/index.md) (1 shared tag)
- [Reading the report](/docs/user-guide/evals-sdk/red-teaming/reading_the_report/index.md) (1 shared tag)
- [Red teaming](/docs/user-guide/evals-sdk/red-teaming/index.md) (1 shared tag)


## Implementation

### TypeScript

- [harness-sdk/strands-ts/src/vended-interventions/dogwood/dogwood.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/vended-interventions/dogwood/dogwood.ts)
