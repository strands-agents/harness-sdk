# Compatibility Policy

This document outlines the Strands SDK's policy on changes that are **not considered breaking changes** under semantic versioning. The policy applies to both the TypeScript and Python SDKs (`strands-py`, `strands-ts`); Strands harness and the Strands CLI are 0.x and follow [their own rule](../site/src/content/docs/user-guide/harness/versioning.mdx). Understanding these policies helps you anticipate how the SDK may evolve without requiring major version bumps.

## Field to Property Conversion

Converting a public mutable field to a property with accessor logic **is not considered a breaking change**, even when adding validation or side effects.

### Policy

The SDK may convert public mutable fields to properties in minor or patch releases. This includes adding:
- Validation logic that throws errors for invalid values
- Side effects during assignment (logging, notifications, state updates)
- Computed or transformed values when reading the property

### Rationale

In both TypeScript/JavaScript and Python, property accessors are syntactically and behaviorally identical to direct field access from the consumer's perspective. Consumers cannot distinguish between direct field access and property access at the call site, so the implementation change is transparent to user code.

### Example

The agent's `model` attribute is currently a public mutable field. In a future release, it may gain accessor logic to add validation:

```typescript
// TypeScript — before: direct field access
agent.model = newModel
const currentModel = agent.model

// After: getter/setter with validation (identical usage)
private _model: Model<BaseModelConfig>
public get model(): Model<BaseModelConfig> {
  return this._model
}
public set model(value: Model<BaseModelConfig>) {
  if (!value) {
    throw new Error('Model cannot be null or undefined')
  }
  this._model = value
}
```

```python
# Python — before: direct attribute access
agent.model = new_model
current_model = agent.model

# After: property with validation (identical usage)
@property
def model(self) -> Model:
    return self._model

@model.setter
def model(self, value: Model) -> None:
    if value is None:
        raise ValueError("Model cannot be None")
    self._model = value
```

User code remains unchanged and continues to work as before.

## Union Type Extensions

Adding new types or classes to union types **is not considered a breaking change**, unless the union explicitly declares that it will no longer change.

### Policy

The SDK may add new event types, result variants, or other union members in minor or patch releases. This includes:
- New event types in streaming results
- Additional error types in result unions
- New configuration options in config unions
- Extended enum-like union types

### Rationale

Union type extensions are additive changes that don't break existing code. Consumers handle union types through type guards, switch statements, or pattern matching that focus on known variants. New union members are simply ignored by existing logic.

### Example

The stream event type returned by the agent's streaming API may receive new event types:

```typescript
// TypeScript — current usage continues to work
for await (const event of agent.stream('Hello')) {
  if (event.type === 'textDelta') {
    console.log(event.text)
  }
  // New event types are ignored by existing code
}
```

```python
# Python — current usage continues to work
async for event in agent.stream_async("Hello"):
    if "data" in event:
        print(event["data"])
    # New event types are ignored by existing code
```

New event types added to the union don't affect existing event handling logic.

## `"auto"` Settings

Changing what an `"auto"` setting resolves to **is not considered a breaking change**.

An `"auto"` setting is one documented as "the SDK picks the best approach it currently has" rather than as a specific mechanism. `HumanInTheLoop("auto")` is the first; the same policy covers any later one.

### Policy

The SDK may change what an `"auto"` setting resolves to in a **minor** release. Patch releases may only fix the current implementation, never swap it for a different approach. Every such change is called out in the release notes for that version, naming the setting, what it resolved to before, and what it resolves to now.

A change may move behavior in **either direction**. For `HumanInTheLoop("auto")`, a release may escalate calls to the human that previously ran on their own, and it may also auto-approve calls that previously escalated. A new strategy is adopted when it classifies risk more accurately overall, which generally means being right more often in both directions rather than uniformly stricter.

The guarantees that do hold across releases:

- The setting keeps its meaning. `HumanInTheLoop("auto")` always means "the SDK decides which tool calls need a human", so the handler always has a strategy and never degrades to approving everything.
- The options accepted alongside it keep working, and they take precedence over the strategy. For `HumanInTheLoop("auto")` those are `ask` and `allowed_tools` / `allowedTools`: an allow-listed tool is never escalated and a `!`-negated one always asks, whatever strategy is underneath.
- Defaults are untouched. Changing `"auto"` never changes what the setting's absence does.

Callers who need behavior fixed across upgrades configure the mechanism explicitly instead — for the handler, `classifier=True` or a `DecisionModel` of their own, which pins today's strategy and is never re-pointed.

### Rationale

This follows [Pay for Play](./DECISIONS.md): writing `"auto"` *is* the opt-in. The value's documented contract is an outcome, not an implementation, so a caller who chooses it has asked for the SDK's current best judgment and gets it on upgrade. Code that doesn't use `"auto"` is unaffected, and the setting is never a default — plain `HumanInTheLoop()` still requires approval for every tool not on the allow list.

Pinning `"auto"` to its first implementation would make the name worthless: callers would be stuck on whatever classifier shipped first, and the SDK would need a new public value for each improvement. The alternative of leaving the policy unwritten is worse — callers have no way to tell which releases may move the behavior.

### Example

```python
# Python — the strategy behind "auto" may change in a minor release
agent = Agent(interventions=[HumanInTheLoop("auto")])

# Pinned: the built-in LLM risk classifier, now and after upgrades
agent = Agent(interventions=[HumanInTheLoop(classifier=True)])
```

```typescript
// TypeScript — the strategy behind 'auto' may change in a minor release
const agent = new Agent({ interventions: [new HumanInTheLoop('auto')] })

// Pinned: the built-in LLM risk classifier, now and after upgrades
const agent = new Agent({ interventions: [new HumanInTheLoop({ classifier: true })] })
```

## Feedback

If you have questions or concerns about this compatibility policy, please [open an issue](https://github.com/strands-agents/harness-sdk/issues) on GitHub.
