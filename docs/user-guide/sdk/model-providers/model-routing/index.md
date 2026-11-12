Use model routing to choose a model for each agent invocation from a fixed set of candidates. It fits agents that need a backup model after failures or need request content to determine which model handles the work.

Configure `ModelRouter` as the agent’s model. The first candidate is the default, and the routing strategy owns the opening choice and every decision after an unclaimed model failure.

The examples use [Amazon Bedrock](/docs/user-guide/sdk/model-providers/amazon-bedrock/index.md). Before running them, configure AWS credentials and model access. Model routing accepts models from any supported provider, but each candidate must be stateless: conversation history stays with the agent instead of the provider.

## How model routing works

To reason about a routing decision, separate the components that the router coordinates:

-   **Candidate**: A stateless model or nested `ModelRouter` available for selection.
-   **Default candidate**: The first declared candidate, used when a strategy declines the opening choice.
-   **Routing strategy**: Selects the opening candidate and decides whether to switch after an unclaimed model failure.
-   **Routing context**: Supplies request messages, agent instructions, tool specifications, candidates, a read-only view of invocation state, and prior attempts to a strategy.
-   **Failure round**: Starts with the opening candidate or a candidate that just succeeded. Routing selects each candidate at most once until the next success; same-model retries do not select it again.

## Choose a routing strategy

Choose the strategy that matches how your application should select and recover:

| Goal | Strategy |
| --- | --- |
| Try candidates in order, then favor healthier candidates | Default `FallbackStrategy` |
| Choose the opening candidate from the request and evidence | `ClassifierStrategy` |
| Define a custom candidate-selection policy | Custom `RoutingStrategy` |

`ClassifierStrategy` does not select another candidate after the serving model fails. Implement a custom strategy when you need classifier-based opening selection and fallback recovery together.

## Configure model routing

To configure routing without changing how you invoke the agent:

1.  Create the stateless model instances that can serve the request.
2.  Wrap a model in `RoutingCandidate` when a strategy needs a name, description, or metadata as selection evidence.
3.  Choose the default fallback, `ClassifierStrategy`, or a custom `RoutingStrategy`.
4.  Construct `ModelRouter` with the candidates and optional strategy.
5.  Pass the router as the agent’s model. Do not attach it through the plugin list.

The agent invocation API stays the same. The following sections show each strategy with complete configuration.

## Route failures to a backup model

Use the default strategy when you want ordered fallback without a separate routing call. On the first failure round of each invocation, `FallbackStrategy` walks the candidates in declaration order: the first candidate opens the invocation, and each unclaimed failure moves to the next candidate. After a model succeeds, later failure rounds use health history. The strategy picks the untried candidate with the fewest recorded failures and uses declaration order to break ties.

(( tab "Python" ))
```python
from strands import Agent
from strands.models import BedrockModel, ModelRouter

primary_model = BedrockModel(
    model_id="us.amazon.nova-pro-v1:0",
)
backup_model = BedrockModel(
    model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
)

router = ModelRouter(
    models=[primary_model, backup_model],
    max_switches=1,
)
agent = Agent(model=router)

agent("Summarize the tradeoffs of active-active deployment.")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import { Agent, BedrockModel, ModelRouter } from '@strands-agents/sdk'

const primaryModel = new BedrockModel({
  modelId: 'us.amazon.nova-pro-v1:0',
})
const backupModel = new BedrockModel({
  modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
})

const router = new ModelRouter([primaryModel, backupModel], {
  maxSwitches: 1,
})
const agent = new Agent({ model: router })

await agent.invoke('Summarize the tradeoffs of active-active deployment.')
```
(( /tab "TypeScript" ))

Set `max_switches``maxSwitches` to cap successful candidate changes during one invocation. The cap does not count retries of the same model. Omit it when the strategy should decide when routing stops.

## Route each request by content

Use `ClassifierStrategy` when request complexity, domain, cost, or latency should choose the opening candidate. By default, it selects the least capable candidate that can still deliver a complete and accurate result, reserving more capable candidates for work that needs them.

Give each candidate a short name, a description, and optional metadata that explain where it fits. Metadata keys must be strings, and metadata values must be JSON-serializable. This example supplies metadata and overrides the default policy to prefer the lowest-latency candidate that satisfies every request requirement.

(( tab "Python" ))
```python
from strands import Agent
from strands.models import (
    BedrockModel,
    ClassifierStrategy,
    ModelRouter,
    RoutingCandidate,
)

routing_policy = (
    "Choose the lowest-latency candidate that satisfies every request requirement. "
    "Use candidate metadata as evidence."
)
classifier_model = BedrockModel(
    model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
    max_tokens=64,
    streaming=False,
    temperature=0,
)
routine_model = BedrockModel(model_id="us.amazon.nova-lite-v1:0")
advanced_model = BedrockModel(model_id="us.amazon.nova-pro-v1:0")

router = ModelRouter(
    models=[
        RoutingCandidate(
            routine_model,
            name="routine",
            description="Concise factual questions and routine requests.",
            metadata={"cost": "low", "latency": "low", "complexity": "routine"},
        ),
        RoutingCandidate(
            advanced_model,
            name="advanced",
            description="Systems design with several interacting constraints.",
            metadata={"cost": "high", "latency": "medium", "complexity": "advanced"},
        ),
    ],
    strategy=ClassifierStrategy(
        classifier_model,
        system_prompt=routing_policy,
    ),
)
agent = Agent(model=router)

agent(
    "Design a rollback-safe migration from regional to global idempotency keys."
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import {
  Agent,
  BedrockModel,
  ClassifierStrategy,
  ModelRouter,
  RoutingCandidate,
} from '@strands-agents/sdk'

const routingPolicy =
  'Choose the lowest-latency candidate that satisfies every request requirement. ' +
  'Use candidate metadata as evidence.'
const classifierModel = new BedrockModel({
  modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  maxTokens: 64,
  temperature: 0,
})
const routineModel = new BedrockModel({
  modelId: 'us.amazon.nova-lite-v1:0',
})
const advancedModel = new BedrockModel({
  modelId: 'us.amazon.nova-pro-v1:0',
})

const router = new ModelRouter(
  [
    new RoutingCandidate({
      model: routineModel,
      name: 'routine',
      description: 'Concise factual questions and routine requests.',
      metadata: { cost: 'low', latency: 'low', complexity: 'routine' },
    }),
    new RoutingCandidate({
      model: advancedModel,
      name: 'advanced',
      description: 'Systems design with several interacting constraints.',
      metadata: { cost: 'high', latency: 'medium', complexity: 'advanced' },
    }),
  ],
  {
    strategy: new ClassifierStrategy(classifierModel, {
      systemPrompt: routingPolicy,
    }),
  }
)
const agent = new Agent({ model: router })

await agent.invoke(
  'Design a rollback-safe migration from regional to global idempotency keys.'
)
```
(( /tab "TypeScript" ))

With two or more candidates, the classifier makes one additional model call before the first serving call. Choose a classifier model that supports structured outputtool calling and forced tool selection.

Set `system_prompt``systemPrompt` to supply your routing policy. The policy can prioritize cost, latency, region, capabilities, or another criterion represented in candidate evidence. The SDK appends mandatory isolation, valid-index, and structured-output rules to every custom policy.

The classifier receives a bounded representation of the latest request-bearing user message, textual agent instructions, and candidate names, descriptions, and metadata. Keep secrets out of that evidence because it can cross a model provider boundary.

The classifier prompt tells the model not to infer preference from declaration order. If the classifier call times out, fails, or returns an invalid choice, the router uses the first candidate. Candidate evidence that exceeds `max_candidate_chars``maxCandidateChars` raises `ValueError``Error` instead.

`ClassifierStrategy` only chooses the opening model. If the selected model fails and no same-model retry claims the failure, the strategy declines further selection. The router surfaces the selected model’s original error instead of switching candidates.

## Build a custom routing strategy

Implement `RoutingStrategy`, the protocolinterface, when the built-in policies do not match your routing goal. The contract defines one asynchronous `select` method. It receives a `RoutingContext` and returns one of that context’s candidate instances or `None``undefined` to decline.

`ModelRouter` decides when to call `select`, applies the selected candidate, and tracks switches and failure rounds. The strategy chooses a candidate or declines; it does not perform the transition itself.

The example implements the contract by combining classifier-based opening selection with fallback after a failed serving attempt.

(( tab "Python" ))
```python
from typing import Any

from strands import Agent
from strands.models import (
    BedrockModel,
    ClassifierStrategy,
    FallbackStrategy,
    ModelRouter,
    RoutingCandidate,
    RoutingContext,
    RoutingStrategy,
)


class ClassifyThenFallback:
    def __init__(self, classifier: ClassifierStrategy) -> None:
        self._classifier = classifier
        self._fallback = FallbackStrategy()

    async def select(
        self,
        context: RoutingContext,
        **kwargs: Any,
    ) -> RoutingCandidate | None:
        if not context.attempts:
            return await self._classifier.select(context, **kwargs)
        return await self._fallback.select(context, **kwargs)


classifier_model = BedrockModel(
    model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
    max_tokens=64,
    streaming=False,
    temperature=0,
)
strategy: RoutingStrategy = ClassifyThenFallback(
    ClassifierStrategy(classifier_model)
)
router = ModelRouter(
    models=[
        RoutingCandidate(
            BedrockModel(model_id="us.amazon.nova-lite-v1:0"),
            name="routine",
            description="Concise factual questions and routine requests.",
        ),
        RoutingCandidate(
            BedrockModel(model_id="us.amazon.nova-pro-v1:0"),
            name="advanced",
            description="Systems design with several interacting constraints.",
        ),
    ],
    strategy=strategy,
)
agent = Agent(model=router)
agent("Design a rollback-safe migration from regional to global idempotency keys.")
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import {
  Agent,
  BedrockModel,
  ClassifierStrategy,
  FallbackStrategy,
  ModelRouter,
  RoutingCandidate,
  type RoutingContext,
  type RoutingStrategy,
} from '@strands-agents/sdk'

class ClassifyThenFallback implements RoutingStrategy {
  private readonly _classifier: ClassifierStrategy
  private readonly _fallback = new FallbackStrategy()

  constructor(classifier: ClassifierStrategy) {
    this._classifier = classifier
  }

  async select(context: RoutingContext): Promise<RoutingCandidate | undefined> {
    if (context.attempts.length === 0) {
      return this._classifier.select(context)
    }
    return this._fallback.select(context)
  }
}

const classifierModel = new BedrockModel({
  modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  maxTokens: 64,
  temperature: 0,
})
const strategy = new ClassifyThenFallback(new ClassifierStrategy(classifierModel))
const router = new ModelRouter(
  [
    new RoutingCandidate({
      model: new BedrockModel({
        modelId: 'us.amazon.nova-lite-v1:0',
      }),
      name: 'routine',
      description: 'Concise factual questions and routine requests.',
    }),
    new RoutingCandidate({
      model: new BedrockModel({
        modelId: 'us.amazon.nova-pro-v1:0',
      }),
      name: 'advanced',
      description: 'Systems design with several interacting constraints.',
    }),
  ],
  { strategy }
)
const agent = new Agent({ model: router })
await agent.invoke(
  'Design a rollback-safe migration from regional to global idempotency keys.'
)
```
(( /tab "TypeScript" ))

A custom `select` method can inspect the request, tool specifications, candidate metadata, read-only invocation state, and prior attempts. Routing strategies must not mutate invocation state. The method must return one of the candidate instances in its routing context. Returning a new, equivalent candidate is an error.

## Restrict candidates per tenant

When one agent serves several tenants (the customers of your application), each tenant may approve only some models. Enforce that rule in the routing strategy, not in a `BeforeModelCallEvent` hook. The router selects the candidate after that hook runs, so the hook cannot see which model will serve the call.

The strategy below reads the tenant from invocation state, keeps only the candidates that tenant allows, and passes them to another strategy. The rule also applies after a failure, so the router never fails over to a candidate the tenant does not allow. When no allowed candidate is left, the original model error reaches the caller.

(( tab "Python" ))
```python
from dataclasses import replace
from typing import Any

from strands import Agent
from strands.models import (
    BedrockModel,
    FallbackStrategy,
    ModelRouter,
    RoutingCandidate,
    RoutingContext,
    RoutingStrategy,
)

TENANT_VENDORS = {
    "customer-a": {"amazon", "anthropic"},
    "customer-b": {"amazon"},
}


class TenantPolicy:
    def __init__(self, inner: RoutingStrategy) -> None:
        self._inner = inner

    async def select(
        self,
        context: RoutingContext,
        **kwargs: Any,
    ) -> RoutingCandidate | None:
        tenant = context.invocation_state.get("tenant")
        vendors = TENANT_VENDORS.get(str(tenant), set())
        allowed = [
            c for c in context.candidates
            if (c.metadata or {}).get("vendor") in vendors
        ]
        if not allowed:
            raise PermissionError(f"tenant {tenant!r} has no allowed model")

        choice = await self._inner.select(
            replace(context, candidates=allowed), **kwargs
        )
        # A declined opening choice serves the first candidate, which may be denied
        if choice is None and not context.attempts:
            return allowed[0]
        return choice


router = ModelRouter(
    models=[
        RoutingCandidate(
            BedrockModel(
                model_id="us.anthropic.claude-haiku-4-5-20251001-v1:0",
            ),
            name="claude",
            metadata={"vendor": "anthropic"},
        ),
        RoutingCandidate(
            BedrockModel(model_id="us.amazon.nova-pro-v1:0"),
            name="nova",
            metadata={"vendor": "amazon"},
        ),
    ],
    strategy=TenantPolicy(FallbackStrategy()),
)
agent = Agent(model=router)

agent(
    "Summarize the tradeoffs of active-active deployment.",
    invocation_state={"tenant": "customer-b"},
)
```
(( /tab "Python" ))

(( tab "TypeScript" ))
```typescript
import {
  Agent,
  BedrockModel,
  FallbackStrategy,
  ModelRouter,
  RoutingCandidate,
  type RoutingContext,
  type RoutingStrategy,
} from '@strands-agents/sdk'

const tenantVendors: Record<string, readonly string[]> = {
  'customer-a': ['amazon', 'anthropic'],
  'customer-b': ['amazon'],
}

class TenantPolicy implements RoutingStrategy {
  private readonly _inner: RoutingStrategy

  constructor(inner: RoutingStrategy) {
    this._inner = inner
  }

  async select(context: RoutingContext): Promise<RoutingCandidate | undefined> {
    const tenant = context.invocationState.tenant
    const vendors =
      typeof tenant === 'string' && Object.hasOwn(tenantVendors, tenant)
        ? tenantVendors[tenant]!
        : []
    const allowed = context.candidates.filter((c) => {
      const vendor = c.metadata?.vendor
      return typeof vendor === 'string' && vendors.includes(vendor)
    })
    if (allowed.length === 0) {
      throw new Error(`tenant ${String(tenant)} has no allowed model`)
    }

    const choice = await this._inner.select({ ...context, candidates: allowed })
    // A declined opening choice serves the first candidate, which may be denied
    if (choice === undefined && context.attempts.length === 0) {
      return allowed[0]
    }
    return choice
  }
}

const router = new ModelRouter(
  [
    new RoutingCandidate({
      model: new BedrockModel({
        modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      }),
      name: 'claude',
      metadata: { vendor: 'anthropic' },
    }),
    new RoutingCandidate({
      model: new BedrockModel({
        modelId: 'us.amazon.nova-pro-v1:0',
      }),
      name: 'nova',
      metadata: { vendor: 'amazon' },
    }),
  ],
  { strategy: new TenantPolicy(new FallbackStrategy()) }
)
const agent = new Agent({ model: router })

await agent.invoke('Summarize the tradeoffs of active-active deployment.', {
  invocationState: { tenant: 'customer-b' },
})
```
(( /tab "TypeScript" ))

`customer-b` opens on Nova Pro and never falls back to Claude. A tenant with no entry, or a request without one, raises before any model runs. To choose the opening candidate by request content, wrap a strategy such as the `ClassifyThenFallback` strategy in [Build a custom routing strategy](#build-a-custom-routing-strategy) instead of `FallbackStrategy`.

## Understand retries and switches

To predict which model handles each call, separate same-model retries from candidate switches:

1.  The routing strategy chooses a candidate before the first model call.
2.  That model handles later calls in the same agent loop unless a call fails.
3.  `ModelRetryStrategy` gets the first chance to retry the same model.
4.  If no retry claims the failure, the router asks its strategy for another candidate.
5.  A replacement model gets a fresh retry budget. A successful call starts a new failure round and makes the other candidates available again.

The next agent invocation starts with a new routing decision. Routing selects each candidate at most once per failure round, though the retry strategy can call the selected model more than once. This prevents routing cycles.

Each model keeps its own prompt cache

A prompt cache belongs to the model that wrote it. When routing moves a request to another candidate, that candidate cannot read the cached system prompt, tools, or conversation. It processes the full input again without the cache read discount. Because routing decides again on every invocation, a strategy that alternates models from turn to turn can cost more than serving every turn from one model. Compare the cache read and write token counts in the agent’s usage metrics before you route a long conversation turn by turn. See [Bedrock prompt caching](/docs/user-guide/sdk/model-providers/amazon-bedrock-prompt-caching/index.md) and [Anthropic prompt caching](/docs/user-guide/sdk/model-providers/anthropic/index.md#prompt-caching).

## Work within current limits

Choose candidates with comparable context windows and tokenizers so context estimation stays aligned with the selected model.

-   Model routing rejects stateful candidate models.
-   `agent.model` remains the first candidate. Proactive context estimation also uses that default model, even when routing selects another candidate.
-   If a candidate fails after emitting stream events and its replacement completes, streaming consumers receive the failed candidate’s emitted events followed by the replacement’s complete stream.

## Related pages

- [Production Lifecycle Controls](/docs/user-guide/sdk/agents/lifecycle-controls/index.md) (1 shared tag)
- [Retry Strategies](/docs/user-guide/sdk/agents/retry-strategies/index.md) (1 shared tag)
- [Chaos testing](/docs/user-guide/evals-sdk/chaos_testing/index.md) (1 shared tag)
- [Structured output](/docs/user-guide/sdk/agents/structured-output-behavior/index.md) (1 shared tag)
- [Detectors](/docs/user-guide/evals-sdk/detectors/index.md) (1 shared tag)
- [Failure detection](/docs/user-guide/evals-sdk/detectors/failure_detection/index.md) (1 shared tag)
- [Operating Agents in Production](/docs/user-guide/sdk/deploy/operating-agents-in-production/index.md) (1 shared tag)
- [Failure communication evaluator](/docs/user-guide/evals-sdk/evaluators/failure_communication_evaluator/index.md) (1 shared tag)
- [Partial completion evaluator](/docs/user-guide/evals-sdk/evaluators/partial_completion_evaluator/index.md) (1 shared tag)
- [Recovery strategy evaluator](/docs/user-guide/evals-sdk/evaluators/recovery_strategy_evaluator/index.md) (1 shared tag)


## Implementation

### Python

- [harness-sdk/strands-py/src/strands/models/routing/router.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/routing/router.py)
- [harness-sdk/strands-py/src/strands/models/routing/classifier_strategy.py](https://github.com/strands-agents/harness-sdk/blob/main/strands-py/src/strands/models/routing/classifier_strategy.py)

### TypeScript

- [harness-sdk/strands-ts/src/models/routing/router.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/routing/router.ts)
- [harness-sdk/strands-ts/src/models/routing/classifier-strategy.ts](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/routing/classifier-strategy.ts)
