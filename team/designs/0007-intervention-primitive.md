# Intervention: A First-Class Agent Control Primitive

## Table of Contents

- [Problem](#problem)
- [Intervention Primitive](#intervention-primitive)
- [Why Not Separate Plugins?](#why-not-separate-plugins)
- [Proposed API](#proposed-api)
- [How Handlers Compose](#how-handlers-compose)
- [Demos](#demos)
- [Development Plan](#development-plan)
- Appendices: [A (Concrete Instances)](#appendix-a-concrete-instances) · [B (Interface Design Rationale)](#appendix-b-interface-design-rationale) · [C (Why Not Just Hooks?)](#appendix-c-why-not-just-hooks) · [D (Coverage Matrix)](#appendix-d-coverage-matrix) · [E (Userland Workaround)](#appendix-e-userland-workaround) · [F (Naming)](#appendix-f-naming-alternatives)

<details>
<summary><h2>Definitions</h2></summary>

| Term | Definition |
|------|-----------|
| **Plugin** | A Strands extension that hooks into agent lifecycle events (`BeforeToolCallEvent`, `AfterModelCallEvent`, etc.) and mutates the event object directly. The current mechanism for all agent control layers. |
| **Steering** | A Strands vended plugin that uses an LLM to evaluate tool calls and model responses, returning Proceed, Guide (cancel + retry with feedback), or Interrupt (pause for human input). Currently Python-only. |
| **Galileo Agent Control** | A Strands community plugin for runtime governance via configurable rules. Ships as two plugins (`AgentControlPlugin` for deny, `AgentControlSteeringHandler` for guide) because the current plugin interface can't express both. |
| **Datadog AI Guard** | A Strands community plugin that scans for prompt injection, jailbreaking, and data exfiltration at four lifecycle points. |
| **Bedrock Guardrails** | AWS-managed content filtering built into the Bedrock model provider. Scans for content policy violations, PII, and prompt attacks. Currently embedded in the model layer, not a separate plugin. |
| **Cedar** | An open-source authorization policy language by AWS. Evaluates Allow/Deny decisions against principals, actions, resources, and context. Sub-ms, deterministic, formally verifiable. |
| **OPA (Open Policy Agent)** | A general-purpose policy engine using the Rego language. CNCF graduated project. The main alternative to Cedar for policy-based authorization. |
| **`invocation_state`** | A dict passed to a Strands agent on every call. Flows through the entire lifecycle — hooks and tools can read it. Used to carry user identity, roles, and environment context. |
| **`InterruptException`** | The Strands SDK's mechanism for pausing agent execution and requesting human input. Raised by `event.interrupt()`, caught by the agent loop, and surfaced to the caller. |

</details>

---

## Problem

Strands agents have multiple independent control layers — authorization, steering, content guardrails, operational governance — but no shared interface between them. Each is a standalone plugin with its own action vocabulary, its own hook registration, and its own audit log. This creates four concrete problems:

1. **No short-circuiting.** If an authorization handler denies a tool call in sub-ms, there's no way to skip the LLM steering call that's about to spend 100ms+ arriving at the same conclusion. Both plugins fire independently on every tool call because the framework doesn't know they're answering related questions. A plugin *could* check `event.cancelTool` before doing its work, but nothing enforces it — every plugin would need to add that check independently.

2. **Fragmented action model.** Plugins communicate by mutating the event — `event.cancelTool = "..."` for both "you're not allowed" (deny) and "try again with better arguments" (guide). The framework can't distinguish them; whether the agent retries or gives up depends on the model interpreting the string. Steering works around this by being a special plugin type with its own action vocabulary. Galileo needs both deny and guide and had to ship as two separate plugins (`AgentControlPlugin` + `AgentControlSteeringHandler`) because no single plugin interface can express both.

3. **No unified audit.** Each plugin logs on its own (if it logs at all) — authorization to its audit trail, steering to wherever steering logs, Datadog to Datadog. When someone asks "why did the agent delete that record?", you're correlating separate log streams with different formats and no shared request ID.

4. **Ordering and conflict resolution are undefined.** `Agent(plugins=[cedar, steering, guardrails])` looks ordered, but execution depends on hook registration internals that can change between SDK versions. If one plugin allows and another denies, both run, both mutate the event, and last write wins.

This proposal elevates the shared structure behind these control layers into a first-class SDK primitive: **Intervention**.

---

## Intervention Primitive

Several independent tools already control agent behavior at runtime — [steering](https://strandsagents.com/docs/user-guide/concepts/plugins/steering/), [Galileo Agent Control](https://strandsagents.com/docs/community/plugins/agent-control/), [Datadog AI Guard](https://strandsagents.com/docs/community/plugins/datadog-ai-guard/), [Bedrock Guardrails](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html), with [Cedar](https://www.cedarpolicy.com/) and [OPA](https://www.openpolicyagent.org/) authorization planned. They fall into two categories: **operational guardrails** (Galileo, Datadog, Bedrock Guardrails, content guardrails) that enforce rules about *what's happening* regardless of who's doing it, and **authorization** (Cedar, OPA) that enforces rules about *who's allowed to do what*.

They all answer different questions — but they share the same mechanical structure. They all: **intercept** an agent event, **evaluate** against rules, **decide** (proceed, redirect, or block), and **log** the decision. This shared lifecycle is the primitive — **Intervention**. Each control layer is an instance. See [Appendix A](#appendix-a-concrete-instances) for a detailed breakdown of each.

The primitive has four components:

**Events** — Typed event subclasses (`BeforeToolCallEvent`, `AfterModelCallEvent`, etc.) carry relevant context. Handlers only receive events they registered for.

**Action** — Five decisions:

| Action | Meaning | Details |
|--------|---------|---------|
| **Proceed** | Allow | Tool executes or model response is accepted. |
| **Deny** | Hard block, no retry | New action — steering today only has Proceed/Guide/Interrupt. Authorization needs a hard block that means "you are not allowed, period." |
| **Guide** | Cancel + feedback for retry | Tool is cancelled, agent receives combined feedback from all handlers and retries with a different approach. |
| **Interrupt** | Pause for human input | Agent pauses via the SDK's native interrupt system. Human responds, agent resumes. |
| **Transform** | Modify content and continue | Handler returns modified content (e.g. Bedrock Guardrails redacting PII). Framework applies it, pipeline continues. Later handlers see the transformed content, not the original. |

**Evaluation Engine** — Each instance uses a different engine (Cedar policies, LLM judge, API call, regex). The primitive doesn't prescribe how you evaluate, only what you return. See [Appendix A](#appendix-a-concrete-instances) for details on each.

**Audit Trail** — Every handler logs its decision into a unified stream.

---

## Why Not Separate Plugins?

The core issue: plugins mutate the event, intervention handlers return decisions.

```typescript
// Plugin: mutates the event directly
beforeToolCall(event: BeforeToolCallEvent): void {
    if (!this.isAuthorized(event)) {
        event.cancelTool = "Access denied"  // deny? guide? interrupt? framework can't tell
    }
}

// Intervention handler: returns a typed decision, framework applies it
async beforeToolCall(event: BeforeToolCallEvent): Promise<InterventionAction> {
    if (!this.isAuthorized(event)) {
        return new Deny("User not authorized for this tool")
    }
}
```

When the framework understands the decision, it can short-circuit, compose, audit, and resolve conflicts — the problems from the previous section. All of this *could* be built on raw hooks (see [Appendix C](#appendix-c-why-not-just-hooks)), but every control layer ends up re-implementing the same patterns independently — short-circuiting, action vocabularies, audit logging, conflict resolution. When multiple independent teams converge on the same abstractions, that's a code smell of a missing primitive. Permissions and control layers should be first-class in an agent framework, not something each team cobbles together from low-level hooks. The same way web frameworks ship middleware rather than asking developers to wire up request/response interception by hand.

---

## Proposed API

Today, each control layer is a standalone plugin with no shared interface, no ordering guarantees, and no unified audit log:

```typescript
const agent = new Agent({
    tools: [queryDatabase, sendEmail],
    plugins: [cedarPlugin, steeringPlugin],
    // Cedar and steering fire independently — no way to skip steering when Cedar denies
})
```

With interventions as a first-class parameter:

```typescript
const agent = new Agent({
    tools: [queryDatabase, sendEmail],
    interventions: [cedar, guardrails, steering],  // cheapest first
})
```

**Why first-class?** The framework owns composition — ordering, short-circuiting, conflict resolution, and a unified audit log are all built in. Steering becomes one instance of `InterventionHandler`, not a special concept.

**Backwards compatibility:** The intervention primitive will be implemented in TypeScript first, then Python. Existing Python plugins (steering, Galileo Agent Control, Datadog AI Guard) continue to work unchanged — interventions are additive. Existing control layers will be migrated to `InterventionHandler` instances incrementally (see [Development Plan](#development-plan)).

### The `InterventionHandler` Interface

The base class provides default no-op methods for each lifecycle event. Handlers override the ones they care about — the framework detects which methods were overridden and only calls those:

```typescript
class CedarAuth extends InterventionHandler {
    name = "cedar-auth";

    // Only beforeToolCall is overridden — framework knows this handler only cares about BeforeToolCall
    async beforeToolCall(event: BeforeToolCallEvent): Promise<InterventionAction> {
        return new Deny("not authorized");
    }
}
```

```python
class CedarAuth(InterventionHandler):
    name = "cedar-auth"

    # Same pattern — only define what you care about
    async def before_tool_call(self, event: BeforeToolCallEvent) -> InterventionAction:
        return Deny(reason="not authorized")
```

New event types can be added without breaking existing handlers — they default to Proceed. For why this is a separate primitive rather than raw hooks, see [Appendix C](#appendix-c-why-not-just-hooks).

### The `InterventionRegistry`

The framework provides an `InterventionRegistry` that wires handlers into the Strands hook system. It registers one callback per event type, dispatches to all matching handlers in registration order, and applies conflict resolution:

Actions are resolved in priority order: **Deny > Interrupt > Transform > Guide > Proceed**.

- **Deny** short-circuits immediately — remaining handlers never run
- **Interrupt** short-circuits — pauses execution via `event.interrupt()` for human input
- **Transform** applies the modification to the event and continues — later handlers see the transformed content
- **Guide** accumulates across handlers — feedback from all handlers is concatenated, then the tool is cancelled with the combined guidance so the agent can retry. Handlers are responsible for tracking their own retry count and escalating to Deny or Interrupt after repeated failures. The registry may also enforce a configurable max-retry safety net.
- **Proceed** continues to the next handler

Every decision is logged to a unified audit trail accessible via `agent.interventions.auditLog`. This is complementary to OTEL — the audit trail provides a structured schema (handler, event type, action, reason, principal, tool) that can be exported to OTEL traces, not a replacement for them.

---

## How Handlers Compose

Handlers are evaluated in registration order, cheapest first:

1. **Cedar, guardrails** — sub-ms, deterministic
2. **Agent Control, Datadog AI Guard** — ms-range, service calls
3. **LLM Steering** — 100ms+, LLM call

At each lifecycle point, only handlers that overrode the corresponding method run:

```
User: "Query the secrets database for all API keys"

  BeforeModelCall:
    ├─ Bedrock Guardrails:  Scan for PII, content policy → PROCEED (or TRANSFORM if redacted)
    ├─ Datadog AI Guard:    Scan prompt for injection    → PROCEED
    └─ Agent Control:       Check centralized rules      → PROCEED

  [Model responds: query_database(database="secrets", ...)]

  BeforeToolCall:
    ├─ Cedar Auth:          Is bob (analyst) allowed?  → DENY
    │                       ← short-circuits here
    ├─ Guardrails:          (never reached)
    ├─ Datadog AI Guard:    (never reached)
    └─ LLM Steering:        (never reached — saved ~100ms)
```

**Deny** short-circuits immediately. **Interrupt** pauses if no handler denied. **Transform** modifies content and continues. **Guide** accumulates across handlers.

No single handler catches everything — the value is in composition. See [Appendix D](#appendix-d-coverage-matrix) for the full matrix.

### Interrupt: Human-in-the-Loop

When a handler returns `Interrupt`, the registry calls `event.interrupt()` — the SDK's native mechanism for pausing execution and requesting human input. The agent pauses, the caller prompts the human, and on resume the handler's `evaluate()` runs again with the human's response available. Any handler can return `Interrupt` for any reason — authorization for consent-gated tools, a guardrail on flagged-but-ambiguous content, steering when it's unsure. See [`DEMO_CONSENT_WALKTHROUGH.md`](./demos/DEMO_CONSENT_WALKTHROUGH.md) for a worked example using Cedar consent policies.

---

## Demos

We implemented the native `Agent(interventions=[...])` parameter in both the Python and TypeScript Strands SDKs.

**Python** — [`demos/intervention/native.py`](../python/strands-cedar-auth/demos/intervention/native.py)

```python
from strands import Agent, InterventionHandler, Proceed, Deny, Guide
from strands.hooks.events import BeforeToolCallEvent

agent = Agent(
    tools=[query_database, send_email, search],
    interventions=[cedar, guardrails, steering],
)
result = agent("Query the analytics database", invocation_state={"user_id": "bob", "roles": ["analyst"]})
```

**TypeScript** — [`demos/intervention/native.ts`](../js/strands-cedar-auth/demos/intervention/native.ts)

```typescript
const agent = new Agent({
  tools: [queryDatabase, sendEmail, search],
  interventions: [cedar, ops, guardrails, datadog, steering],
})
```

Five handlers across all 4 event types, 10 scenarios including prompt injection, jailbreak detection, and steering guidance.

**Consent demo** — [`demos/consent.py`](../python/strands-cedar-auth/demos/consent.py)

Interactive agent where consent-gated tools pause via `Interrupt` and prompt the human for approval. Uses the same `CedarAuthHandler` with `.consent()` on its builder.

**SDK forks:**

| SDK | Fork |
|-----|------|
| Python | [lizradway/sdk-python@interventions](https://github.com/lizradway/sdk-python/tree/interventions) |
| TypeScript | [lizradway/sdk-typescript@interventions](https://github.com/lizradway/sdk-typescript/tree/interventions) |

See [Appendix E](#appendix-e-userland-workaround) for the userland pipeline we built to prove the concept.

---

## Development Plan

**TypeScript (first):**

1. **Intervention primitive.** Implement `InterventionHandler`, `InterventionAction` (including `Transform`), and `InterventionRegistry` in the TypeScript SDK — the `Agent({ interventions: [...] })` parameter proposed in this doc.

2. **Steering intervention handler.** Implement steering as an `InterventionHandler`. This is the first handler on the primitive and validates the interface design.

3. **Cedar intervention handler.** Build the Cedar authorization handler using [`cedar-wasm`](https://github.com/cedar-policy/cedar/tree/main/cedar-wasm) — the official WASM bindings maintained by the Cedar team.

**Python (second):**

4. **Intervention primitive.** Port `InterventionHandler`, `InterventionAction`, and `InterventionRegistry` to the Python SDK.

5. **Steering intervention handler.** Migrate the existing Python `SteeringHandler` to implement `InterventionHandler`.

6. **Bedrock Guardrails intervention handler.** Move Bedrock Guardrails from the model provider layer onto the intervention primitive.

7. **Cedar intervention handler.** Build the Cedar authorization handler using [`cedarpy`](https://pypi.org/project/cedarpy/) (externally maintained Rust-backed Python bindings). When Strands Python 2.0 moves to WASM bindings, this is replaced by the official `cedar-wasm` from step 3.

**Additional handlers** (content guardrails, OPA, etc.) added as needed based on demand.

---

<details>
<summary><strong>Appendix A: Concrete Instances</strong></summary>

| | Cedar Auth | OPA Auth | LLM Steering | Datadog AI Guard | Bedrock Guardrails | Galileo Agent Control |
|---|---|---|---|---|---|---|
| **Question** | *Is this principal allowed?* | *Is this principal allowed?* | *Is this the right thing to do?* | *Is this content safe?* | *Is this content safe?* | *Does this violate a rule?* |
| **Engine** | Cedar policies (native/WASM) | OPA/Rego (WASM) | LLM judge | Datadog API | Bedrock API | Centralized rule server |
| **Hook points** | `BeforeToolCall` | `BeforeToolCall` | `BeforeToolCall`, `AfterModelCall` | 4 events | `BeforeModelCall`, `AfterModelCall` | 7 events |
| **Latency** | Sub-ms | Sub-ms | 100ms+ | ms | ms | ms |

### 1. Cedar Authorization

```
Engine:      Cedar policy evaluation (native/WASM, sub-ms, deterministic)
Actions:     Proceed | Deny | Interrupt (for consent-gated tools)
Posture:     Default-deny
Strength:    Formally verifiable, identity-aware, argument-level scoping per role
Hook points: BeforeToolCall
```

Answers "is this principal authorized?" — identity-aware, argument-level scoping per role, formally verifiable. Returns `Interrupt` instead of `Deny` when a residual policy exists that would approve with human consent. See the [Cedar Authorization design doc](https://github.com/strands-agents/harness-sdk/blob/main/team/designs/0006-cedar-authorization.md) for the full proposal.

```python
cedar = CedarAuthHandler.builder()
    .role("analyst", tools=["search", "query_database"])
    .restrict("query_database", allowed_values={"database": ["analytics"]})
    .build()
```

### 2. OPA Authorization (proposed)

```
Engine:      OPA/Rego policy evaluation (WASM, sub-ms, deterministic)
Actions:     Proceed | Deny
Posture:     Configurable (default-deny or default-allow depending on policy)
Strength:    General-purpose policy engine, CNCF graduated, broad ecosystem
Hook points: BeforeToolCall
```

Answers the same authorization question as Cedar using OPA's Rego language. CNCF graduated with a large ecosystem. Does not support formal verification of the policy set.

```python
opa = OpaAuthHandler(
    policy_path="./policies.rego",
    data_path="./roles.json",
)
```

### 3. LLM Steering (Strands built-in)

```
Engine:      LLM with natural-language system prompt
Actions:     Proceed | Guide | Interrupt (tool steering)
             Proceed | Guide (model steering)
Posture:     Default-proceed
Strength:    Flexible, handles ambiguous/subjective criteria
Hook points: BeforeToolCall (tool steering), AfterModelCall (model steering)
```

The most flexible engine — anything you can express in language. Non-deterministic and high-latency. Best used last in the pipeline. Tool steering can Proceed, Guide (cancel + retry with feedback), or Interrupt (pause for human input). Model steering can Proceed (accept response) or Guide (discard response and retry with guidance injected into conversation).

```python
from strands.vended_plugins.steering import LLMSteeringHandler

handler = LLMSteeringHandler(
    system_prompt="Ensure emails maintain a cheerful, positive tone."
)
agent = Agent(tools=[send_email], plugins=[handler])
```

### 4. Datadog AI Guard ([Strands community plugin](https://strandsagents.com/docs/community/plugins/datadog-ai-guard/))

```
Engine:      Datadog AI Guard API (prompt injection, jailbreak, data exfiltration detection)
Actions:     Proceed | Deny
Posture:     Default-proceed (threat detection approach)
Strength:    Multi-point scanning, content-focused, service-backed
Hook points: BeforeModelCall, AfterModelCall, BeforeToolCall, AfterToolCall
```

Scans at **four** lifecycle points — the broadest hook coverage of any instance. The event-driven `InterventionHandler` interface accommodates this naturally.

```python
from ddtrace.appsec.ai_guard import AIGuardStrandsPlugin

guard = AIGuardStrandsPlugin(
    detailed_error=True,
    raise_error_on_tool_calls=True,
)
agent = Agent(tools=[search, send_email], plugins=[guard])
```

### 5. Content Guardrails (custom rules)

```
Engine:      Pattern matching, classifier models, blocklists
Actions:     Proceed | Deny
Posture:     Default-proceed (blocklist approach)
Strength:    Fast, deterministic, content-focused
Hook points: BeforeToolCall (typically)
```

Checks *what's being said*, not *who's saying it*. PII detection, SQL injection, toxic content. Identity-unaware.

### 6. Galileo Agent Control ([Strands community plugin](https://strandsagents.com/docs/community/plugins/agent-control/))

```
Engine:      Centralized rule server or local controls.yaml, evaluated at runtime
Actions:     Proceed | Deny | Guide (via AgentControlSteeringHandler)
Posture:     Default-proceed (blocklist/rule-match approach)
Strength:    Centralized policy management, no-code rule updates, dual enforcement modes
Hook points: BeforeInvocation, BeforeModelCall, AfterModelCall, BeforeToolCall, AfterToolCall, BeforeNodeCall, AfterNodeCall
```

Ships as **two complementary plugins** — `AgentControlPlugin` (Deny) and `AgentControlSteeringHandler` (Guide) — because Strands doesn't yet have a unified intervention interface. This is the strongest evidence that the primitive is needed.

```python
from agent_control.integrations.strands import AgentControlPlugin, AgentControlSteeringHandler

blocker = AgentControlPlugin(agent_name="my-agent")
guide = AgentControlSteeringHandler(agent_name="my-agent")

agent = Agent(tools=[search, send_email], plugins=[blocker, guide])
```

### 7. Bedrock Guardrails (Strands built-in)

```
Engine:      AWS Bedrock Guardrails API (content filtering, PII detection, topic blocking)
Actions:     Proceed | Deny | Transform
Posture:     Default-proceed (content scanning approach)
Strength:    AWS-managed, covers content policy + PII + grounding checks in one service
Hook points: BeforeModelCall, AfterModelCall
```

Currently embedded inside the Bedrock model provider as config (`guardrail_id`, `guardrail_redact_input`, etc.) rather than a separate plugin. As an intervention handler, it moves from the model layer to the control layer — composable with Cedar, steering, and everything else. The `ANONYMIZED` action (PII redaction) is the primary use case for the `Transform` intervention action.

```typescript
class BedrockGuardrailHandler extends InterventionHandler {
    name = "bedrock-guardrails";

    async beforeModelCall(event: BeforeModelCallEvent): Promise<InterventionAction> {
        const assessment = await this.evaluate(event.prompt);
        if (assessment.action === "BLOCKED") return new Deny("Input blocked by guardrail");
        if (assessment.action === "ANONYMIZED") return new Transform(assessment.redactedContent, "PII redacted from input");
        return new Proceed();
    }

    async afterModelCall(event: AfterModelCallEvent): Promise<InterventionAction> {
        const assessment = await this.evaluate(event.response);
        if (assessment.action === "BLOCKED") return new Deny("Response blocked by guardrail");
        if (assessment.action === "ANONYMIZED") return new Transform(assessment.redactedContent, "PII redacted from response");
        return new Proceed();
    }
}
```

</details>

<details>
<summary><strong>Appendix B: Interface Design Rationale</strong></summary>

We considered three approaches for how handlers declare which events they care about:

1. **`handles()` + `evaluate()`** — one generic evaluate method, handler declares event types via a `handles()` set. Clean but couples interventions to the hook type system.

2. **Fixed abstract methods per event** — `evaluateToolCall()`, `evaluateModelInput()`, etc. Explicit but brittle: adding a new event type means adding a new abstract method, breaking every existing handler.

3. **Fixed methods with default no-ops** — same as #2 but methods default to Proceed. Handlers override what they care about, ignore the rest. New events don't break existing handlers.

We chose option 3 for both languages — default no-op methods that handlers override for the events they care about. The framework detects which methods were overridden and only calls those. Same pattern in Python and TypeScript.

</details>

<details>
<summary><strong>Appendix C: Why Not Just Hooks?</strong></summary>

You can build all of this with vanilla hooks today — and that's exactly what every existing control layer does. The question is whether the pattern is common and error-prone enough to justify a framework primitive.

The things you'd have to build yourself with raw hooks:

1. **Short-circuiting.** Each hook would need to check `event.cancelTool` before doing its work, and every plugin author needs to remember to do this. If one forgets, it runs anyway (e.g., an LLM steering call for a tool that's already been denied).

2. **Distinguishing deny from guide.** Both set `event.cancelTool` to a string. The only difference is what the string says. Whether the agent retries or gives up depends on the model interpreting natural language, not on a typed decision the framework can act on.

3. **Ordered evaluation.** You'd need to carefully control plugin registration order and hope it doesn't change between SDK versions.

4. **Audit logging.** Each hook would need to log its own decisions, in its own format, to its own destination. Correlating them after the fact is manual.

None of these are impossible — they're just the same boilerplate that every team with multiple control layers ends up writing. The intervention primitive is the framework absorbing that boilerplate so individual handlers don't have to.

</details>

<details>
<summary><strong>Appendix D: Coverage Matrix</strong></summary>

| Threat | Caught By | Missed By |
|--------|-----------|-----------|
| Unauthorized access (wrong role) | Cedar, OPA | Guardrails, Steering, Agent Control, Bedrock Guardrails |
| PII in tool input | Guardrails, Datadog AI Guard, Bedrock Guardrails (Transform) | Cedar, OPA, Steering |
| SQL injection | Guardrails, Datadog AI Guard | Cedar, OPA, Bedrock Guardrails |
| Prompt injection in user input | Datadog AI Guard, Bedrock Guardrails | Cedar, OPA, Guardrails, Steering |
| Jailbreak / data exfiltration | Datadog AI Guard, Bedrock Guardrails | Cedar, OPA, Guardrails |
| Off-task/low-quality tool use | LLM Steering | Cedar, OPA, Guardrails, Bedrock Guardrails |
| Argument-level scoping (wrong DB) | Cedar, OPA | Guardrails, Steering, Bedrock Guardrails |
| Operational policy violation | Agent Control | Cedar, OPA, Steering, Bedrock Guardrails |
| Corrective behavioral guidance | Agent Control, LLM Steering | Cedar, OPA, Guardrails, Bedrock Guardrails |
| Human consent for high-stakes tools | Cedar (Interrupt) | OPA, Guardrails, Agent Control, Bedrock Guardrails |
| Content policy (hate, violence, etc.) | Bedrock Guardrails, Datadog AI Guard | Cedar, OPA, Steering |
| PII redaction (Transform) | Bedrock Guardrails | All others (block but don't redact) |

</details>

<details>
<summary><strong>Appendix E: Userland Workaround</strong></summary>

We built a userland `InterventionPipeline` ([`pipeline.py`](../python/strands-cedar-auth/demos/intervention/pipeline.py), [`pipeline.ts`](../js/strands-cedar-auth/demos/intervention/pipeline.ts)) that wraps multiple handlers into a single Strands `Plugin`. It works — ordered evaluation, short-circuiting, unified audit log, all without SDK changes. But composition, ordering, and interrupt propagation are framework-level concerns. Every team building a production agent with multiple control layers would end up writing the same wrapper. The SDK should own this once.

</details>

<details>
<summary><strong>Appendix F: Naming Alternatives</strong></summary>

"Intervention" is the working name, but it carries a connotation of something going wrong (medical intervention, addiction intervention). Authorization isn't corrective — it's a gate. Alternatives worth considering:

| Name | API | Pros | Cons |
|---|---|---|---|
| **Intervention** | `Agent(interventions=[...])` | Descriptive — something intervenes in the loop | Implies misbehavior. Unfamiliar as a CS primitive |
| **Middleware** | `Agent(middleware=[...])` | Instantly familiar to every web engineer. Accurate | May imply single-request linear chain, not multi-event |
| **Guard** | `Agent(guards=[...])` | Short, clear, implies protection | Overloaded — Rust `guard`, Python `@guard`, Galileo uses it |
| **Policy** | `Agent(policies=[...])` | Accurate for Cedar/OPA | Doesn't fit LLM steering — steering isn't really "policy" |
| **Control** | `Agent(controls=[...])` | Neutral | Vague. "Agent control" is already Galileo's product name |
| **Gate** | `Agent(gates=[...])` | Clear metaphor — things pass through or don't | Implies binary allow/deny, doesn't capture Guide/Interrupt |
| **Interceptor** | `Agent(interceptors=[...])` | Accurate — intercepts events and decides | Java/Spring vibes, slightly dated |

The final name should be decided before any SDK PR.

</details>
