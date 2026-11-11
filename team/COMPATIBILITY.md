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

## Preset and `"auto"` Setting Expansions

Changing what a preset or `"auto"` setting expands to **is not considered a breaking change**. The *name* is the stable contract, not its expansion.

This covers any setting whose documented meaning is a named outcome the SDK owns the implementation of, rather than a specific mechanism the caller chose:

- `context_manager="auto"` / `"agentic"` — the preset expansions (truncation thresholds, the summarization utilization point). Already documented this way on the [context management presets page](../site/src/content/docs/user-guide/sdk/context-management/presets.mdx); this entry writes the rule down rather than introducing it.
- `HumanInTheLoop("auto")` — which approval strategy decides that a tool call needs a human.

It does **not** cover an `"auto"` that states a fact rather than selecting an implementation. `ModelCapabilities.prompt_caching="auto"` describes how a given model caches; it is a property of that model, not a choice the SDK re-makes between releases.

### Policy

The SDK may change what a preset or `"auto"` setting expands to in a **minor** release. Patch releases may only fix the current expansion, never swap it for a different approach. Every such change is called out in the release notes for that version, naming the setting, what it expanded to before, and what it expands to now.

A change may move behavior in **either direction**. For `HumanInTheLoop("auto")`, a release may escalate calls to the human that previously ran on their own, and it may also auto-approve calls that previously escalated. A new strategy is adopted when it classifies risk more accurately overall, which generally means being right more often in both directions rather than uniformly stricter.

The guarantees that do hold across releases:

- The setting keeps its meaning. `HumanInTheLoop("auto")` always means "the SDK decides which tool calls need a human", so the handler always has a strategy and never degrades to approving everything. `context_manager="auto"` always reduces context proactively rather than only on overflow.
- The options accepted alongside it keep working, and they take precedence over the strategy. For `HumanInTheLoop("auto")` those are `ask` and `allowed_tools` / `allowedTools`: an allow-listed tool is never escalated and a `!`-negated one always asks, whatever strategy is underneath.
- Defaults are untouched. Changing `"auto"` never changes what the setting's absence does.

Callers who need behavior fixed across upgrades configure the mechanism explicitly instead. For the handler, `classifier=True` always means the built-in LLM classifier and is never re-pointed to a different strategy.

That pins the mechanism, not its verdicts. The classifier's default risk prompt is SDK-owned and may change like any other default, and the classifier runs on `agent.aux_model` / `agent.auxModel`. A caller who needs the criteria themselves fixed supplies them — their own prompt and model via `LLMClassifierConfig` / `LlmClassifierConfig`, or their own `DecisionModel`. The line this policy draws is between *which* mechanism runs, which an explicit `classifier` fixes, and *how that mechanism behaves*, which only caller-supplied criteria fix.

### Rationale

This follows [Pay for Play](./DECISIONS.md): writing the preset name *is* the opt-in. Its documented contract is an outcome, not an implementation, so a caller who chooses it has asked for the SDK's current best judgment and gets it on upgrade. Code that doesn't use the preset is unaffected, and these settings are never defaults — plain `HumanInTheLoop()` still requires approval for every tool not on the allow list.

Pinning a preset to its first expansion would make the name worthless: callers would be stuck on whatever shipped first, and the SDK would need a new public value for each improvement. Leaving the rule unwritten is worse — the context manager's presets have worked this way since they shipped, but only the one page documenting them says so, and nothing told a reader which releases may move the behavior or whether a safety-relevant setting like approval routing was included.

What is new with `HumanInTheLoop("auto")` is not the pattern but the subject matter: the expansion decides which tool calls reach a human. That is why this entry states the direction question explicitly instead of leaving it to be inferred.

### Example

```python
# Python — which strategy decides may change in a minor release
agent = Agent(interventions=[HumanInTheLoop("auto")])

# Mechanism fixed: always the built-in LLM classifier, but its default prompt is SDK-owned
agent = Agent(interventions=[HumanInTheLoop(classifier=True)])

# Criteria fixed too: the caller supplies the prompt and model
agent = Agent(
    interventions=[HumanInTheLoop(classifier=LLMClassifierConfig(system_prompt=..., model=...))]
)
```

```typescript
// TypeScript — which strategy decides may change in a minor release
const agent = new Agent({ interventions: [new HumanInTheLoop('auto')] })

// Mechanism fixed: always the built-in LLM classifier, but its default prompt is SDK-owned
const agent = new Agent({ interventions: [new HumanInTheLoop({ classifier: true })] })

// Criteria fixed too: the caller supplies the prompt and model
const agent = new Agent({
  interventions: [new HumanInTheLoop({ classifier: { systemPrompt, model } })],
})
```

## Feedback

If you have questions or concerns about this compatibility policy, please [open an issue](https://github.com/strands-agents/harness-sdk/issues) on GitHub.
