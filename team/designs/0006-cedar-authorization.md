# Cedar Authorization Plugin for Strands Agents SDK

## Table of Contents

- [Problem](#problem)
  - [Why Not Just Create Different Agents With Different Tool Sets?](#why-not-just-create-different-agents-with-different-tool-sets)
  - [Why Not Just Use IAM / Application-Layer Auth?](#why-not-just-use-iam--application-layer-auth)
- [Proposal](#proposal)
  - [How It Works](#how-it-works)
  - [Identity](#identity)
  - [Why Cedar](#why-cedar)
  - [Authorization Request](#authorization-request)
- [Schema Generation and Static Verification](#schema-generation-and-static-verification)
- [Developer API](#developer-api)
  - [Builder](#builder)
  - [Config file (`from_config`)](#config-file-from_config)
  - [Full Cedar (advanced)](#full-cedar-advanced)
- [Implementation](#implementation)
- [Future: Intervention Handler Primitive](#future-cedar-as-an-intervention-handler)
- Appendices: [A (Design Decisions)](#appendix-a-key-design-decisions) · [B (Framework Identity)](#appendix-b-how-other-frameworks-handle-identity) · [C (Runtime Conditions)](#appendix-c-runtime-condition-examples) · [D (Control Plugins)](#appendix-d-comparison-with-existing-control-plugins) · [E (Tool-Set Swapping)](#appendix-e-tool-set-swapping-vs-cedar) · [F (Resource Resolver)](#appendix-f-resource-resolver-formats) · [G (Verifier/CI)](#appendix-g-verifier-api-and-cicd-integration) · [H (Full Cedar)](#appendix-h-full-cedar-examples) · [I (Cedar vs. OPA)](#appendix-i-cedar-vs-opa) · [J (Cedar Under the Hood)](#appendix-j-cedar-model-mapping)

<details>
<summary><h2>Definitions</h2></summary>

| Term | Definition |
|------|-----------|
| **Cedar** | An open-source policy language by AWS, purpose-built for authorization. Evaluates Allow/Deny decisions against principals, actions, resources, and context. |
| **OPA (Open Policy Agent)** | A general-purpose policy engine using the Rego language. CNCF graduated project. The main alternative to Cedar for policy evaluation. |
| **AVP (Amazon Verified Permissions)** | Cedar-as-a-service — a managed AWS service for centralized policy management and evaluation with CloudTrail integration. |
| **Strands** | An open-source Python SDK for building AI agents, developed by AWS. Agents invoke tools on behalf of users via a model-driven loop. |
| **RBAC** | Role-Based Access Control — permissions assigned to roles (e.g., "admins can delete records"). |
| **ABAC** | Attribute-Based Access Control — permissions based on attributes of the principal, resource, or environment (e.g., "users can only query their own department's data"). |
| **ReBAC** | Relationship-Based Access Control — permissions based on relationships between entities (e.g., "users can access resources owned by their team"). |
| **Galileo Agent Control** | A Strands plugin by Galileo that enforces operational guardrails — rate limits, argument validation, tool blocking. Not identity-aware. |
| **Datadog AI Guardrails** | ML-based content guardrails that score agent outputs for hallucination, toxicity, and PII leakage. Not identity-aware. |
| **Steering plugins** | Strands plugins that guide agent behavior via LLM-based evaluation (Proceed / Guide / Interrupt). Content-aware, not identity-aware. |
| **`invocation_state`** | A dict passed to a Strands agent on every call. Flows through the entire lifecycle — hooks and tools can read it. Used by the Cedar plugin to carry user identity. |
| **`cedarpy`** | Rust-backed Python bindings wrapping the official `cedar-policy` crate. Externally maintained. Used for in-process policy evaluation (zero-network, microsecond latency). |
| **Principal** | In Cedar, the entity performing the action — typically the end user, but can also be a service, IAM role, or agent. |
| **MCP** | Model Context Protocol — a standard for describing tools that AI models can call. The `cedar-for-agents` repo includes MCP-focused schema generation. |

</details>


## Problem

AI agents invoke tools on behalf of users, but today there is no standard way to control *which* user can invoke *which* tool. Developers either hard-code permission checks inside each tool or skip per-tool auth entirely. This leads to authorization logic that is scattered, hard to audit, and impossible to analyze statically. As agents gain access to higher-stakes tools (database writes, API calls, file deletion), the gap between "what the model can do" and "what the user is allowed to do" becomes a security liability. AWS research identifies that "access controls weren't continuously validated while the agent was running" as a root cause of cascading agent failures [[3]](#appendix-k-references). No other agent framework offers a production-grade authorization story out of the box. This isn't a theoretical gap — the Strands community is [actively asking how to handle it](https://www.reddit.com/r/AI_Agents/comments/1rc4f8k/how_are_you_guys_handling_security_for_strands/), with practitioners converging on the same conclusion: "the model proposes, the system enforces."

Three examples where this surfaces today:

- **Autonomous agents with powerful credentials** — An agent with a GitHub PAT or IAM role makes autonomous tool-call decisions. Prompt instructions are the only guardrail, and the LLM can ignore them. See [`DEMO_WALKTHROUGH.md`](./demos/DEMO_WALKTHROUGH.md) for a real-world audit.
- **Multi-user agents sharing one deployment** — One agent serves many users with different roles through the same credentials. IAM and API gateways can't distinguish who triggered which tool call. See [`DEMO_SAAS_WALKTHROUGH.md`](./demos/DEMO_SAAS_WALKTHROUGH.md) for a worked example.
- **Tools that need human consent** — High-stakes tools (send email, delete file) should pause for approval before executing. Products like Kiro and Claude Code hardcode permission categories in application code, but the model can't be customized per user or context without code changes. Cedar externalizes this into policy. See [`DEMO_CONSENT_WALKTHROUGH.md`](./demos/DEMO_CONSENT_WALKTHROUGH.md) for a worked example.

Most agents today are single-user, but even in the single-user case, you don't want the agent to have the full permissions of the user it's acting on behalf of — you want it to have the *least* permissions required for the task at hand [[4]](#appendix-k-references). Cedar enforces this before you ever get to multi-tenancy. As agents move to production deployments serving many users, tool-level authorization becomes a hard requirement. Starting with single-user guardrails today doesn't require rearchitecting when you add multi-user support later.

### Why Not Just Create Different Agents With Different Tool Sets?

The obvious alternative to Cedar is: just make a different agent per role.

```python
analyst_agent = Agent(tools=[search, read_report])
admin_agent = Agent(tools=[search, read_report, delete_record, provision_account])
```

This is the right question, and for simple cases the answer is: **you should just do that.** Two roles, three tools, no conditional logic — make two agents and move on. Cedar is not for that case.

Cedar is for when tool-set swapping breaks down. Here's where that happens:

#### 1. Same tool, different permissions on its arguments

Tool-set swapping is binary: a tool is in the set or it isn't. But real authorization is often about *how* a tool is used, not *whether* it exists.

**Example**: Everyone gets `query_database`. But analysts can only query tables in their department. Managers can query across departments. Compliance can query anything but only in read-only mode.

You can't express this by including or excluding `query_database` — the tool is the same, the permission varies by who's calling it and what arguments they pass. You'd have to build three separate `query_database_analyst`, `query_database_manager`, `query_database_compliance` tools that are functionally identical except for a hard-coded permission check. That's just authorization with extra steps.

#### 2. The model loses the ability to explain denial

When you remove a tool from the agent's tool set, the model doesn't know that capability exists. If a user asks "delete that record", the model will say something like "I don't have the ability to delete records" — which is wrong. The agent *can* delete records, this user just isn't allowed to.

With Cedar, the model sees all tools, attempts the call, gets a structured denial, and can tell the user: *"You don't have permission to delete records. Contact your admin to request access."* This is a better user experience and a more honest answer.

#### 3. Runtime conditions that don't exist at agent construction time

Some authorization decisions depend on context that only exists at the moment of the tool call — time of day, environment flags, rate limits, approval status. Tool-set swapping can't handle these because the agent is already constructed.

Cedar evaluates these as `when` clauses on context passed in by the plugin: `context.hour_utc < 9`, `context.session_call_count >= 10`, `context.deploy_freeze == true`. The plugin gathers the runtime state; Cedar makes the decision. See [Appendix C](#appendix-c-runtime-condition-examples) for detailed examples of time-based, environment-based, rate-based, and approval-based conditions.

#### 4. Separation of concerns — who owns permissions?

With tool-set swapping, the person writing the API router / agent factory is encoding the permission model in Python code. This means:

- **Security teams can't review permissions** without reading your application code
- **Changing permissions requires a code change** — PR, review, deploy
- **Permissions aren't versionable as a standalone artifact** — they're scattered across constructors and if-statements
- **No static analysis** — you can't ask "which roles can reach `delete_record`?" without tracing through your code

Cedar makes permissions a **separate artifact** — a `.cedar` file, a `.toml` config, or a `.json` file that security teams can read, review, and analyze without understanding your Python codebase. This is the same reason web apps use authorization middleware instead of hard-coding `if user.role == "admin"` in every route handler. AWS enterprise guidance recommends exactly this: "make policy part of the agent's shape, not a gate at the end" and enforce it "at the tool level, not just in the agent's prompt" [[4]](#appendix-k-references).

#### 5. One policy set for many principals

Whether it's tenants with different entitlements, users with different roles, or sub-agents with different scopes — tool-set swapping means per-principal code paths. Cedar gives you one policy set that covers all of them declaratively. Different roles, different argument scopes, different rate limits, all in the same policy file. You can statically verify that no principal can reach a tool they shouldn't.

#### 6. Multi-agent delegation and permission scoping

In a Strands swarm or graph, Agent A (a coordinator) hands off work to Agent B (a specialist). Agent B has powerful tools. The question: should Agent B be able to use *all* its tools, or only the ones that Agent A's original user is allowed to trigger?

With tool-set swapping, Agent B has a fixed tool set — it doesn't know or care who Agent A's user is. With Cedar, the original user's identity propagates through the delegation chain, and Agent B's tools are gated by the same policies:

```cedar
// Agent B can only use tools that the originating user is allowed to use
// The principal is the original user, not the agent
permit (
  principal in Team::"cloud_platform",
  action == Action::"terminate_ec2_instance",
  resource
) when {
  resource.account_id in principal.managed_accounts
};
```

This works today without SDK changes — Strands' `Graph` and `Swarm` multi-agent primitives already propagate `invocation_state` to each sub-agent's tool calls, so the Cedar plugin in each sub-agent sees the original user's identity automatically.

See [Appendix E](#appendix-e-tool-set-swapping-vs-cedar) for a side-by-side comparison table. **The rule of thumb**: If your permission model is "role X gets tools A, B, C" and nothing more, use tool-set swapping. If you need argument-level gating, runtime conditions, static analysis, or multi-agent permission propagation, you need a policy engine.

### Why Not Just Use IAM / Application-Layer Auth?

"My agent runs with AWS credentials. I'll scope those with IAM policies. Or I'll check permissions in my API layer before calling the agent. Why do I need auth *inside* the agent?"

#### Traditional apps vs. agents: the control flow changed

In a traditional app, the control flow is predictable. User clicks a button, your code runs a known function, you check permissions, done. Every action traces directly back to a user interaction.

Agents broke this. A user sends one message — "help me clean up our staging environment" — and the agent autonomously decides to call `list_instances`, then `terminate_ec2_instance` four times, then `delete_database`, then `send_email` to notify the team. **The user didn't ask for five of those six actions.** The agent decided them.

Your API gateway authorized the chat message. IAM allows the agent to call EC2 and RDS. Neither layer has any opinion about whether *this user* should be able to trigger `terminate_ec2_instance` through *this agent*. Both layers say "allowed" for every user, every time.

#### The principal problem

**Shared credentials (the common case):** Your agent has one IAM role. Ten users talk to it. When Alice (admin) asks the agent to delete a record and Bob (intern) asks the same, IAM sees the exact same principal making the exact same `DynamoDB:DeleteItem` call. Both succeed. This is the same reason your web app doesn't rely solely on database credentials — the app connects to Postgres as one service account, and nobody says "just use Postgres roles for user auth." You need an authorization layer that knows about users.

**Per-user credentials:** Some apps store per-user credentials (OAuth tokens, API keys) and make calls as the user — the service does see the right principal. But IAM condition keys don't map to "which tool did the agent choose to call" or "what arguments did it decide to pass." Per-user credentials scope *which APIs* the agent can hit, not *which tools* the agent can choose or *how* it uses them. IAM alone can't enforce argument-level restrictions, rate limits, or time windows at the tool-call level — that requires an authorization layer inside the agent.

#### The enforcement gap

Your API gateway authorized the user's request. Your application code validated the input. Then you called `agent("clean up staging")` and handed control to a model.

What happens next is **not in your code**. The model decides which tools to call, in what order, with what arguments. It might:

- Call `query_database(database="production")` when the user should only access `staging`
- Chain `send_email` 20 times because the model thought it was being helpful
- Call `delete_record` on records the user never mentioned because the model inferred they were "related"
- Escalate from a read operation to a write operation because the model decided to "fix" something it found

None of these actions were in the user's original request. The application layer authorized the request. The agent made autonomous decisions after that. There is no existing layer that intercepts those decisions.

#### Where each auth layer stops

| Auth layer | What it knows | What it doesn't know |
|------------|--------------|---------------------|
| API gateway | This user is authenticated and hit a valid endpoint | What the agent will do with their message |
| IAM | This process can call DynamoDB and S3 | Which user triggered this specific call |
| Database permissions | This connection can run SELECT and INSERT | Whether this user should see this particular row |
| Tool-level if/else checks | This specific tool's business rules | What other tools were called, rate limits across tools, unified audit trail |

Each layer has a blind spot that the others can't cover. IAM doesn't know about users. The API gateway doesn't know about tool calls. Database permissions don't cover non-database tools. Tool-level checks are scattered, inconsistent, and invisible to static analysis.

#### The tool-call boundary is the only chokepoint

Every action an agent takes — AWS API call, internal service request, database query, file operation, third-party SaaS call, shell command — flows through the tool-call loop. It's the one point where you know: *who* is the user, *what* tool is being called, *with what arguments*, and *in what context* (time, environment, how many times this session).

This is what the plugin hooks into. It's the equivalent of middleware in a web framework — every request passes through it, and you can enforce policy uniformly without scattering auth checks across every handler. Amazon Bedrock AgentCore Policy enforces the same pattern at the managed infrastructure layer — Cedar policies evaluated at the gateway before every tool execution [[6, 7]](#appendix-k-references). This plugin brings that same model into the framework itself.

Without it, you have two choices:

1. **Trust the agent.** Every user gets the agent's full capability set. Hope the model doesn't do anything inappropriate. This is the default today, and it's fine for demos and single-user tools. It's not fine for production multi-user agents with destructive tools.

2. **Roll your own.** Add permission checks inside each tool. Maintain a list of who can call what. Track rate limits manually. Build audit logging. Parse role information in every tool function. Congratulations — you've built a bespoke, untested, unanalyzable authorization system scattered across your codebase. Cedar replaces that with a purpose-built policy language that can be reviewed, versioned, tested, and statically verified as a standalone artifact.

#### How this differs from existing control plugins

Strands steering plugins and external guardrails (Galileo Agent Control, Datadog) can enforce operational constraints like rate limits and argument validation — but they are **not identity-aware**. They apply the same rules to every user. Agent Control can say "max 5 `send_email` calls," but not "admins get 10, analysts get 3." It can block certain argument values, but not "Alice can query production, Bob can only query analytics." Cedar policies are written in terms of *principals* — the same constraint varies by who's calling. Cedar is the only layer that composes all three dimensions — identity, tool-level granularity, and conditional constraints — in one declarative, statically analyzable policy. Guardrails and steering are complementary layers, not alternatives. See [Appendix D](#appendix-d-comparison-with-existing-control-plugins) for the full comparison.

#### When you don't need this

Not every agent needs this:

- **All tools are read-only** — no destructive operations, no sensitive data
- **Two roles, three tools, no conditional logic** — just build two agents with different tool sets

The plugin exists for the gap between "my API has auth" and "the agent is making autonomous decisions." If that gap doesn't exist in your system, you don't need it.

## Proposal

**`CedarAuthPlugin`** is a Cedar-native Strands plugin that uses the [Cedar policy language](https://github.com/cedar-policy/cedar) to enforce fine-grained, auditable authorization over every tool call an agent makes. Cedar is purpose-built for authorization: it is fast (bounded-latency evaluation), analyzable (automated reasoning can prove policy properties [[1, 2]](#appendix-k-references)), and expressive enough to cover RBAC, ABAC, and ReBAC models in a single policy set.

### How It Works

The plugin hooks into the Strands agent lifecycle at two points:

| Hook | Event | What happens |
|------|-------|-------------|
| **Pre-tool gate** | `BeforeToolCallEvent` | Constructs a Cedar authorization request from the tool call context and evaluates it against the loaded policy set. If the decision is `Deny`, sets `event.cancel_tool` with a denial message — the tool never executes. |
| **Post-tool audit** | `AfterToolCallEvent` | Logs the authorization decision, tool result (or exception), and full request context to a structured audit trail. |

Because Strands plugins auto-register hooks via the `@hook` decorator, no changes to the core SDK or to individual tools are required. Authorization is orthogonal to tool implementation.

#### Identity

Strands agents accept an `invocation_state` dict on every call. Today it carries only framework internals — there is no `user_id`, `principal`, or `roles`. The dict is caller-extensible, so the plugin uses it to carry identity without any SDK changes. No agentic SDK has built-in tool-level authorization today ([Appendix B](#appendix-b-how-other-frameworks-handle-identity)); authorization is inherently opinionated, so it lives in an optional plugin.

**How identity flows in:** Strands is a library, not a server. Your application authenticates users and passes identity into `invocation_state`:

```
User authenticates → [Your API layer] → extracts identity → passes into invocation_state → agent runs
```

```python
# FastAPI example
@app.post("/chat")
async def chat(request: ChatRequest, user: User = Depends(get_current_user)):
    result = agent(
        request.message,
        invocation_state={
            "user_id": user.id,          # from JWT "sub" claim
            "roles": user.roles,          # from JWT "groups" claim
        }
    )
    return result
```

The plugin reads `event.invocation_state` inside `BeforeToolCallEvent`, constructs a Cedar principal, and evaluates policies. It doesn't validate tokens or talk to identity providers — it trusts that `invocation_state` contains a verified identity, the same trust boundary as any authorization middleware.

**Any auth mechanism works** — OAuth/OIDC, IAM roles, API keys, mTLS, or hardcoded for local dev. Cedar sees a principal string like `User::"alice@acme.com"` or `ServiceRole::"arn:aws:iam::123:role/pipeline"`; how that string was derived is your app's concern. The principal can be a human user, an IAM role, an agent, or a service.

**What the plugin needs from you:** Pass `user_id` and `roles` in `invocation_state`. For non-standard identities, use the builder's `.principal(key, type)` or a Full Cedar custom `principal_resolver`. See the Developer API section for details.

**Fail-closed by design:** If `invocation_state` is missing identity (no `user_id`, no matching key), the principal resolver raises an error and the plugin cancels the tool call with a denial message. The tool never executes. There is no fail-open path — missing identity is treated the same as an explicit deny.

#### Why Cedar

Cedar is purpose-built for authorization — `principal`, `action`, `resource`, and `context` are language primitives, not conventions. It provides formal verification ([automated reasoning](https://aws.amazon.com/what-is/automated-reasoning/) [[1, 2]](#appendix-k-references) that can mathematically prove policy properties — e.g., "no intern can reach `delete_record` in production"), bounded-latency evaluation (no recursion, no loops), and a natural path to AWS-managed authorization via Amazon Verified Permissions. This is a key differentiator: Cedar gives you deterministic, formally verifiable behavior to balance the probabilistic nature of agentic decisions — and it's something OPA cannot offer. We evaluated OPA/Rego as the main alternative; see [Appendix I](#appendix-i-cedar-vs-opa) for the full comparison. The plugin architecture is engine-agnostic, so an OPA plugin is feasible as a community contribution or something we build ourselves if there's demand.

The plugin evaluates policies locally via [`cedarpy`](https://pypi.org/project/cedarpy/) (Rust-backed Python bindings wrapping the official `cedar-policy` crate) — in-process, zero-network, microsecond latency. `cedarpy` is externally maintained, not by the Cedar team; if it falls behind, it's a thin `pyo3` wrapper that's easy to fork, and we have a working WASI fallback (`cedar-wasm-eval`) that eliminates the dependency entirely. For future dynamic entity/policy loading, [`cedar-local-agent`](https://github.com/cedar-policy/cedar-local-agent) provides async pluggable provider traits and caching.

Building this plugin also led to a broader investigation into Cedar as an [intervention handler](#future-cedar-as-an-intervention-handler) — a first-class pipeline where Cedar, steering, and guardrails share a unified interface with ordered evaluation and short-circuiting.

#### Authorization Request

When the model calls a tool, the plugin intercepts the call in `BeforeToolCallEvent` and builds a Cedar authorization request with four parts: **principal**, **action**, **resource**, and **context**. Strands concepts map naturally onto Cedar's model — see [Appendix J](#appendix-j-cedar-model-mapping) for the full mapping table and example policies.

**Principal** — Who is asking. Built from `invocation_state` by the principal resolver (see Identity above).

```
invocation_state = {"user_id": "alice", "roles": ["admin"]}
→ principal = User::"alice"
```

**Action** — Which tool is being called. Auto-derived from the tool name — you don't configure this.

```
tool call: query_database(database="analytics")
→ action = Action::"use_tool::query_database"
```

**Resource** — What the tool is acting on. By default, this is the tool itself (`Tool::"query_database"`). This works when policies are about **which tools** a role can use — which is most cases. Note that tool arguments (like which database, which record ID) are already auto-populated into **context** and available for policy conditions — you don't need a custom resource to gate on argument values. The `resource_resolver` is only needed when you want Cedar *resource-level* policies (e.g., `resource.owner == principal` for ownership checks on domain objects like `Record::"42"`). Most users won't need this — it's a Full Cedar feature. See [Appendix F](#appendix-f-resource-resolver-formats) for all supported formats.

**Context** — Everything Cedar needs to make conditional decisions. The plugin builds this from three sources:

**1. Tool arguments** — copied directly from the model's tool call. If the model calls `query_database(database="analytics", mode="read_only")`, both `database` and `mode` appear in context. This is how Cedar policies can gate based on *how* a tool is used, not just *whether* it's called.

**2. Time enrichments** — the plugin adds these automatically on every request:
- `hour_utc` — current hour (0–23), for time-window policies. Note: Cedar has a native [`datetime` extension](https://www.cedarpolicy.com/blog/datetime-extension) with operators to extract hours, minutes, etc. A future version could use Cedar's built-in datetime type directly instead of pre-computing `hour_utc` as an integer.
- `timestamp` — ISO 8601 timestamp, for audit trails

**3. State enrichments** — added when the relevant builder methods are used:
- `environment` — read from `invocation_state["environment"]`, for `.deny_tools_in_env()`
- `session_call_count` — the plugin's internal counter for this tool in this session, for `.rate_limit()`. Note: counters are in-memory and per-process — they reset on restart and are not shared across horizontally scaled instances. This makes rate limiting a best-effort guardrail, not a hard security boundary. For strict rate enforcement, use an external counter (e.g., Redis) and pass the count via `invocation_state`.

The full context for a `query_database` call looks like:

```json
{
  "database": "analytics",
  "mode": "read_only",
  "hour_utc": 14,
  "timestamp": "2026-03-25T14:30:00Z",
  "environment": "production",
  "session_call_count": 2
}
```

Each field is available in Cedar policies as `context.<field>`:

```cedar
// Tool argument: restrict which databases can be queried
forbid (principal, action == Action::"use_tool::query_database", resource)
when { !(context.database == "analytics" || context.database == "reporting") };

// Time enrichment: only during business hours
forbid (principal, action, resource)
when { context.hour_utc < 9 || context.hour_utc >= 17 };

// State enrichment: rate limit
forbid (principal, action == Action::"use_tool::send_email", resource)
when { context.session_call_count >= 3 };
```

The builder methods (`.restrict()`, `.time_window()`, `.rate_limit()`, `.deny_tools_in_env()`) generate these policies for you. But understanding what's in context is useful if you drop to Full Cedar or want to know why a policy matched.

## Schema Generation and Static Verification

The plugin auto-generates a Cedar schema from the agent's registered tools at startup — one Cedar action per tool, with context records mirroring each tool's parameters. This is analogous to [`cedar-policy-mcp-schema-generator`](https://github.com/cedar-policy/cedar-for-agents) for MCP, adapted for Strands.

Because Cedar policies are analyzable, the plugin exposes a **`CedarPolicyVerifier`** that validates policies against the schema and proves properties before they reach production — no agent instance, no model, no network required:

- **Schema validation**: Catches typos like `Action::"use_tool::delet_record"` and type errors.
- **Reachability**: "Can any principal invoke `delete_record` in production?" — catches overly permissive policies.
- **Completeness**: "Does every tool have at least one permit path?" — catches forgotten policies for new tools.
- **Redundancy**: "Does policy X shadow policy Y?" — finds policies that have no effect.
- **Partial evaluation** (future): Cedar can evaluate requests with missing context and return [residual policies](https://docs.cedarpolicy.com/overview/terminology.html#partial-evaluation) — the conditions that must still hold. This could power smarter `Interrupt` responses (e.g., "I need your department before I can authorize this query").

See [Appendix G](#appendix-g-verifier-api-and-cicd-integration) for the full verifier API and CI/CD examples.

## Developer API

Three entry points, each with a distinct purpose. They all generate Cedar under the hood, so policies are always auditable regardless of which entry point you use.

### How to choose

| | Builder | Config file | Full Cedar |
|-|---|---|---|
| **Entry point** | `CedarAuthPlugin.builder()` | `CedarAuthPlugin.from_config()` | `CedarAuthPlugin()` |
| **When to use** | Simple RBAC through conditional constraints (arg restrictions, rate limits, time windows, env rules) | Same as builder, but config lives outside Python | Relationship-based access, custom entities, resource-level policies |
| **Cedar syntax required** | None | None | Yes |
| **Principal** | Configurable via `.principal(key, type)`, defaults to `user_id` | `[principal]` section in config | Dict `{"key": ..., "type": ...}` or custom function |
| **Resource** | Always `Tool::"tool_name"` | `[resources]` section in config | Custom `resource_resolver` (dict, JSON/TOML file, or function) |
| **Entities** | Auto-generated from roles | Auto-generated from roles | You provide them (`.json` file, list, or callback) |
| **Policies** | Auto-generated from builder methods | Auto-generated from config | You write them (`.cedar` file or inline string) |
| **Config lives in** | Python code | `.toml` / `.json` file | `.cedar` / `.json` files |

**The rule of thumb**: Start with the builder. Move to config file when you want authorization outside of code (different configs per environment, policy changes without code deploys). Move to full Cedar when you need entity relationships or resource-level policies.

Because config file and Full Cedar both store policy in plain files, those files can live anywhere — git, S3, a config service. This naturally separates policy from code and opens a path to centralized management without AVP.

### Builder

From simple RBAC to conditional constraints — argument restrictions, rate limits, time windows, and environment rules. Everything is declarative — no Cedar syntax, no lambdas.

**Available builder methods:**

| Method | What it does |
|--------|-------------|
| `.principal(key, type)` | Set which `invocation_state` key holds the identity and what Cedar type to use. Defaults to `key="user_id"`, `type="User"`. |
| `.role(name, tools)` | Grant a role access to specific tools. Use `["*"]` for all tools. |
| `.restrict(tool, allowed_values, for_role)` | Restrict a tool's arguments to specific values. Optional `for_role` scopes the restriction to one role. |
| `.rate_limit(tool, max_per_session)` | Limit how many times a tool can be called per session. |
| `.time_window(hour_start, hour_end)` | Only allow tool calls during a UTC time window. |
| `.deny_tools_in_env(environment, tools)` | Block specific tools in a given environment. |

```python
plugin = (
    CedarAuthPlugin.builder()

    # Identity: read email from invocation_state instead of user_id
    .principal(key="email")

    # RBAC: role → tools
    .role("admin", tools=["*"])
    .role("analyst", tools=["search", "query_database", "send_email"])

    # Scope tool arguments globally: nobody can query_database outside these databases
    .restrict("query_database", allowed_values={"database": ["analytics", "reporting"]})

    # Or scope to a specific role: only analysts are restricted
    .restrict("query_database", allowed_values={"database": ["analytics", "reporting"]}, for_role="analyst")

    # Rate limit: max 3 send_email calls per session
    .rate_limit("send_email", max_per_session=3)

    # Time window: only allow tool calls 9am-5pm UTC
    .time_window(hour_start=9, hour_end=17)

    # Environment: block destructive tools in production
    .deny_tools_in_env("production", ["delete_record", "drop_table"])

    .build()
)

agent = Agent(plugins=[plugin], tools=[...])
agent("query the analytics db", invocation_state={
    "email": "bob@acme.com",
    "roles": ["analyst"],
    "environment": "production",
})
```

Each builder method generates the corresponding Cedar policy under the hood. The customer never writes Cedar, but it's all Cedar underneath — so the policies are auditable, analyzable, and composable. See [Appendix J](#appendix-j-cedar-model-mapping) for what each method generates.

### Config file (`from_config`)

Same power as the builder, but the entire authorization setup lives in a TOML or JSON file instead of Python code. This means:

- **Permission changes don't require code changes** — edit the config, redeploy
- **Different configs per environment** — `cedar_auth.dev.toml`, `cedar_auth.prod.toml`
- **Non-developers can own the config** — it's TOML, not Python
- **Easy to diff and audit** — TOML changes are readable in PRs

```python
from cedar_auth_plugin import CedarAuthPlugin

plugin = CedarAuthPlugin.from_config("./cedar_auth.toml")
```

Where `cedar_auth.toml`:

```toml
[principal]
key = "email"
type = "User"

[roles]
admin = ["*"]
analyst = ["search", "query_database", "send_email"]

[resources.delete_record]
key = "record_id"
type = "Record"

[restrictions.query_database]
for_role = "analyst"
database = ["analytics", "reporting"]

[rate_limits]
send_email = 3

[time_window]
start = 9
end = 17

[deny_in_env.production]
tools = ["delete_record", "drop_table"]
```

Every section is optional. A minimal config is just `[roles]`:

```toml
[roles]
admin = ["*"]
analyst = ["search", "read_report"]
```

The config file supports the same features as the builder — roles, argument restrictions (with `for_role`), rate limits, time windows, environment denials, principal configuration, and resource resolvers. The plugin generates identical Cedar policies whether you use the builder or the config file.

### Full Cedar (advanced)

For anything the builder can't express — relationship-based access, custom entity hierarchies, resource-level policies, and custom principal resolution logic.

With Full Cedar, config lives in Cedar files — the same way you'd manage Cedar policies in any other Cedar deployment:

```
my-agent/
├── cedar/
│   ├── policies.cedar     # Cedar policies
│   └── entities.json      # Entity hierarchy
├── resources.json          # Resource resolver config (optional)
└── agent.py
```

**What Full Cedar adds over the builder/config file:**

- **Hand-written Cedar policies** — loaded from `.cedar` files. Relationship-based conditions, entity attributes, or anything the builder methods don't cover.
- **Custom entities** — loaded from `.json` files, or provided as a callable for dynamic entity resolution. You define the entity hierarchy directly rather than having the plugin auto-generate it from roles.
- **Custom `principal_resolver`** — accepts a dict `{"key": "iam_role", "type": "IamRole"}` (same format as the builder's `.principal()`) or a function for full control. The function form handles multi-field resolution, conditional types, or arbitrary logic.
- **Custom `resource_resolver`** — extracts domain-specific resources from tool arguments (e.g., `Record::"42"` instead of `Tool::"delete_record"`). Accepts a declarative dict, a JSON/TOML file path, or a callable.

See [Appendix H](#appendix-h-full-cedar-examples) for detailed examples of file loading, custom principal resolvers, and a full-featured configuration.

## Implementation

The plugin belongs in the [`cedar-for-agents`](https://github.com/cedar-policy/cedar-for-agents) repo as `python/strands-cedar-auth/`. The repo exists for "software at the intersection of Cedar and agents" — today it has MCP-focused Rust and JS packages; this adds runtime authorization for a Python agent framework. The package is installable standalone (`pip install strands-cedar-auth`) and depends on `cedarpy` and `strands-agents`.

Several other projects already use Cedar for agent authorization, including Amazon Bedrock AgentCore Policy and Leash by StrongDM.

All demos run with `pip install cedarpy strands-agents`. See [`DEMO_WALKTHROUGH.md`](./demos/DEMO_WALKTHROUGH.md) (autonomous agent guardrails), [`DEMO_SAAS_WALKTHROUGH.md`](./demos/DEMO_SAAS_WALKTHROUGH.md) (multi-user SaaS), and [`DEMO_CONSENT_WALKTHROUGH.md`](./demos/DEMO_CONSENT_WALKTHROUGH.md) (tool consent — allow/deny/requires-approval) for worked examples.

## Future: Intervention Handler Primitive

Today, the Cedar plugin integrates with Strands via the `Plugin` interface — `@hook` decorators that limit Cedar to a binary Allow/Deny outcome. Building this plugin led to a broader investigation into a unified [Intervention primitive](./INTERVENTION_EXPLORATION.md) where Cedar authorization, LLM steering, content guardrails, and operational controls all implement the same `InterventionHandler` interface with a shared action vocabulary: **Proceed**, **Deny**, **Guide**, and **Interrupt**.

The value of a shared primitive is that today each control layer — Cedar, steering, Galileo Agent Control, Datadog AI Guard — is a standalone plugin with its own interface, no ordering guarantees, and no unified audit trail. Galileo already ships as *two* plugins (`AgentControlPlugin` for deny, `AgentControlSteeringHandler` for guide) because Strands lacks a unified way to express both. A first-class intervention interface fixes this: handlers declare which events they care about, return a typed action, and the framework owns ordering, short-circuiting, and audit. Cedar evaluates in sub-ms and short-circuits the pipeline before expensive LLM steering runs. Guardrails and operational controls slot in between. Every handler logs to the same audit stream.

For Cedar specifically, the intervention interface adds **richer actions** — returning `Interrupt` for consent-gated tools instead of a hard `Deny`. The consent pattern, where high-stakes tools pause for human approval via the Strands SDK's native interrupt system, is a concrete example of what this enables. See [`DEMO_CONSENT_WALKTHROUGH.md`](./demos/DEMO_CONSENT_WALKTHROUGH.md) for the full walkthrough, and the [Intervention Exploration](./INTERVENTION_EXPLORATION.md) for the design rationale, proposed API, and working demos.

<details>
<summary><strong>Appendix A: Key Design Decisions</strong></summary>

- **Three entry points**: Builder (common constraints) → Config file (TOML/JSON-driven) → full Cedar (anything). Each entry point generates Cedar under the hood, so policies are always auditable.
- **Builder generates Cedar policies**: Cedar is default-deny (like IAM) — nothing is allowed unless a policy explicitly permits it. The `.role()` method generates the broad `permit` policy for that role, and each `.restrict()`, `.rate_limit()`, `.time_window()`, `.deny_tools_in_env()` call layers a `forbid(...)` policy on top. One risk: if a `forbid` policy is malformed, Cedar skips it during evaluation, which means you fail open for that constraint. The authorization response includes info about skipped policies, so the plugin should check for and surface these.
- **Plugin tracks stateful constraints**: Rate limits require counters. Cedar is stateless, so the plugin maintains call counts per session and passes the count as `context.session_call_count` into each Cedar evaluation. Cedar evaluates the threshold; the plugin manages the state. Session ID resolution falls back through `session_id` → `user_id` → `"_default"` (via `_get_session_id()`).
- **`cancel_tool`**: On denial, the plugin sets `event.cancel_tool` with a human-readable message. The model sees this as a tool error and can explain the denial to the user (confirmed working in the autonomous-agent and SaaS demos with a real model).
- **Action naming**: `Action::"use_tool::{tool_name}"` — one Cedar action per tool, auto-derived from the tool's name.
- **Dynamic entities from `invocation_state`**: The `_dynamic_entities()` static method builds User entities from `invocation_state["user_id"]` and `invocation_state["roles"]` at runtime, with role membership expressed as parent relationships. No static entity JSON required for the simple/builder APIs.
- **Structured audit log**: Every authorization decision is recorded as an `AuthzDecision` dataclass with fields: `principal`, `action`, `resource`, `allowed`, `tool_name`, and `timestamp`. Accessible via the `plugin.audit_log` property.
- **Customizable resource resolution**: The `resource_resolver` parameter accepts a declarative dict (`{"delete_record": {"key": "record_id", "type": "Record"}}`), a JSON/TOML file path, or a callable `(tool_name, tool_input) -> str`. The dict format scales per-tool without growing if/else chains. Tools not in the mapping fall back to `Tool::"tool_name"`.

</details>

<details>
<summary><strong>Appendix B: How Other Frameworks Handle Identity</strong></summary>

| Framework | Identity mechanism | Tool-level auth? |
|-----------|-------------------|-----------------|
| **ADK (Google)** | `user_id` is a **required parameter** on `Runner.run_async()`. Flows through `Session` → `InvocationContext` → tools access via `Context.user_id`. | No. ADK knows who the user is but doesn't gate which tools they can call. |
| **LangChain** | `config["metadata"]` dict on `RunnableConfig`. Generic dict that auto-propagates. No built-in identity keys. | No. LangGraph *Cloud* has `@auth.on.*` handlers — but that's a server-layer feature. |
| **CrewAI** | Nothing for tool execution. Has A2A inter-agent auth (OAuth, OIDC, mTLS) for agents talking to other agents. | No. User identity doesn't reach tool calls. |
| **AutoGen** | Nothing in core. Web UI (AutoGen Studio) has login middleware that doesn't reach agent execution. | No. |

</details>

<details>
<summary><strong>Appendix C: Runtime Condition Examples</strong></summary>

Cedar is **stateless** — it evaluates a single authorization request and returns Allow or Deny. For runtime conditions, the **plugin** gathers state and passes it as context. Cedar evaluates the policy against that context. The split is: plugin gathers facts, Cedar makes the decision.

**Time-based: "Destructive tools only during business hours"**

The plugin passes the current timestamp as context. The policy checks it.

```cedar
forbid (
  principal,
  action in [Action::"delete_record", Action::"terminate_ec2_instance"],
  resource
) when {
  context.hour_utc < 9 || context.hour_utc > 17
};
```

The plugin's `BeforeToolCallEvent` hook does:
```python
context = {
    "hour_utc": datetime.utcnow().hour,
    "day_of_week": datetime.utcnow().strftime("%A"),
    **tool_arguments
}
```

**Environment-based: "No destructive tools during a deploy freeze"**

Same pattern — the plugin passes environment state as context.

```cedar
forbid (
  principal,
  action in [Action::"delete_record", Action::"provision_aws_account"],
  resource
) when {
  context.deploy_freeze == true
};
```

The plugin reads the freeze status from an environment variable, a feature flag service, or a config file. Cedar doesn't care where it comes from.

**Rate-based: "Max 10 `send_email` calls per session"**

Cedar is stateless, so the plugin maintains counters externally and passes the current count as context.

```cedar
forbid (
  principal,
  action == Action::"send_email",
  resource
) when {
  context.session_tool_call_count >= 10
};
```

```python
context = {
    "session_tool_call_count": self.call_counts[session_id].get("send_email", 0),
    **tool_arguments
}
```

The **heavy lifting is in the plugin, not in Cedar**. Cedar's role is making the threshold and scope configurable via policy rather than hard-coded.

**Approval-based: "Purchases over $10,000 require manager approval"**

```cedar
forbid (
  principal,
  action == Action::"submit_purchase_order",
  resource
) when {
  context.amount > 10000 && !context.has_manager_approval
};
```

Cedar does **not** implement the approval workflow — it doesn't pause execution, notify a manager, and wait. The plugin (or a broader system) must detect the denial, trigger an out-of-band approval request, and re-invoke with `context.has_manager_approval = true` on approval. Cedar handles the **decision**; additional infrastructure handles the **workflow**.

Worth noting: Cedar supports [partial evaluation](https://docs.cedarpolicy.com/auth/partial-evaluation.html) [[5]](#appendix-k-references), which returns a *residual policy* when some context is missing at evaluation time. For the approval case, Cedar could return "this request would be allowed *if* `has_manager_approval` is true" — telling you exactly what additional context is needed. This maps naturally to an **Interrupt** action (pause for human input, then re-evaluate with the missing context).

**Summary of the pattern**: Plugin gathers runtime state → passes it as Cedar context → Cedar evaluates → returns Allow/Deny. For simple context (time, environment flags), this is clean. For stateful context (counters, approval status), the plugin carries more weight and Cedar's role is primarily making thresholds configurable via policy.

</details>

<details>
<summary><strong>Appendix D: Comparison with Existing Control Plugins</strong></summary>

| | Strands Steering | Galileo / Datadog Guardrails | Cedar Auth Plugin |
|-|-----------------|---------------------------|-------------------|
| **Question answered** | *"Is the agent following the right procedure?"* — context-aware guidance, tone checks, workflow compliance | *"Is the agent's output safe and high-quality?"* — hallucination detection, toxicity, PII leakage, prompt injection | *"Is this user allowed to invoke this tool?"* — role-based, attribute-based, and relationship-based access control |
| **Decision model** | LLM-based evaluation (Proceed / Guide / Interrupt) | ML scoring (probabilistic, 0–1 thresholds) | Policy evaluation (deterministic Allow/Deny) |
| **What it gates** | Tool calls (cancel + feedback) and model outputs (discard + retry) | Model *outputs* after generation | Tool *invocations* before execution |
| **Identity-aware** | No — evaluates the *action*, not *who* is performing it | No — evaluates content, not who produced it | Yes — policies are written in terms of principals, roles, and resource ownership |
| **Static analysis** | No — LLM evaluations can't be formally verified | No — ML scorers can't be formally verified | Yes — Cedar supports automated reasoning (prove no user can reach a tool, detect policy conflicts) |
| **Bypassable** | Guidance only — the model can choose to ignore steering feedback | Depends on implementation | No — `forbid` policies are enforced at the framework level, before the tool executes. The model cannot override a denial. |

**Steering vs. Cedar**: Steering plugins ([docs](https://strandsagents.com/docs/user-guide/concepts/plugins/steering/)) guide the agent's *behavior* — "review this email for tone before sending," "follow these steps in order," "ask a human if you're unsure." They're about *how* the agent works, not *who* is allowed to do *what*. A steering plugin might cancel a `send_email` call because the tone is wrong; Cedar cancels it because *this user* doesn't have permission to send email. Steering is content-aware; Cedar is identity-aware. They hook into the same `BeforeToolCallEvent`, but they answer fundamentally different questions.

A production agent might use all three: Cedar to enforce *"can this user do this?"* before the tool runs, steering to ensure *"is the agent doing this correctly?"* during execution, and a guardrail platform to evaluate *"was the output safe?"* after the model responds.

</details>

<details>
<summary><strong>Appendix E: Tool-Set Swapping vs. Cedar</strong></summary>

| | Tool-set swapping | Cedar |
|-|-------------------|-------|
| Binary include/exclude a tool | Yes | Yes |
| Gate based on tool arguments | No | Yes |
| Model can explain denial to user | No (tool is invisible) | Yes (tool is visible, denial is structured) |
| Dynamic per-tenant/per-user permissions | Requires custom routing code | Declarative policy |
| Runtime conditions (time, rate, env) | Requires per-call agent reconstruction | Native `when` clauses |
| Permissions are a standalone artifact | No — scattered across code | Yes — `.cedar`, `.toml`, or `.json` files |
| Static analysis of permission set | No | Yes (automated reasoning) |
| Multi-agent permission propagation | No | Yes (principal follows the user) |

</details>

<details>
<summary><strong>Appendix F: Resource Resolver Formats</strong></summary>

The `resource_resolver` parameter accepts four formats. Tools not in the mapping fall back to `Tool::"tool_name"`.

**Declarative dict** — a per-tool mapping of which argument to extract and what Cedar type to use.

```python
plugin = CedarAuthPlugin(
    policies=POLICIES,
    entities=ENTITIES,
    resource_resolver={
        "delete_record": {"key": "record_id", "type": "Record"},
        "terminate_instance": {"key": "instance_id", "type": "Instance"},
    },
)
```

**JSON or TOML file** — the same mapping, loaded from a config file.

```python
plugin = CedarAuthPlugin(
    policies=POLICIES,
    entities=ENTITIES,
    resource_resolver="./resources.json",
)
```

Where `resources.json`:
```json
{
  "delete_record": {"key": "record_id", "type": "Record"},
  "terminate_instance": {"key": "instance_id", "type": "Instance"}
}
```

Or `resources.toml`:
```toml
[resources.delete_record]
key = "record_id"
type = "Record"

[resources.terminate_instance]
key = "instance_id"
type = "Instance"
```

**Callable** — a function `(tool_name, tool_input) -> str` for full control when the dict format isn't enough.

```python
plugin = CedarAuthPlugin(
    policies=POLICIES,
    entities=ENTITIES,
    resource_resolver=lambda tool, args: f'Record::"{args["record_id"]}"' if tool == "delete_record" else f'Tool::"{tool}"',
)
```

All formats enable the same policies:

```cedar
// Only allow deleting records you own
permit (principal, action == Action::"use_tool::delete_record", resource)
when { resource.owner == principal };
```

</details>

<details>
<summary><strong>Appendix G: Verifier API and CI/CD Integration</strong></summary>

The verifier follows the same builder pattern as the plugin itself:

```python
from cedar_policy_verifier import CedarPolicyVerifier

# Option 1: Verify policies from files
verifier = (
    CedarPolicyVerifier.from_files(
        policies="./policies.cedar",
        schema="./schema.cedarschema",
    )
)

# Option 2: Verify policies generated by the builder
plugin = (
    CedarAuthPlugin.builder()
    .role("admin", tools=["*"])
    .role("analyst", tools=["search", "query_database"])
    .restrict("query_database", allowed_values={"database": ["analytics", "reporting"]})
    .build()
)
verifier = CedarPolicyVerifier.from_plugin(plugin)

# Run checks
result = verifier.validate()       # schema validation — are policies well-formed?
result = verifier.check_reachability(
    action="use_tool::delete_record",
    context={"environment": "production"},
)  # can any principal reach this tool in this context?
result = verifier.check_completeness(
    tools=["search", "query_database", "delete_record", "send_email"],
)  # does every tool have at least one permit path?

# All-in-one for CI
verifier.assert_all()  # raises VerificationError with details on first failure
```

**CI/CD Integration:**

```bash
# GitHub Actions / any CI
cedar-strands verify \
  --policies ./policies.cedar \
  --schema ./schema.cedarschema \
  --check schema \
  --check completeness \
  --check "reachability:delete_record:environment=production"
```

The verifier is most useful when paired with the auto-generated schema. A CI pipeline can import the agent's tool definitions, auto-generate the Cedar schema, validate policies against it, and run reachability/completeness checks. This catches a common failure mode: a developer adds a new tool but forgets to write a policy for it.

</details>

<details>
<summary><strong>Appendix H: Full Cedar Examples</strong></summary>

**Loading from files:**

```python
from pathlib import Path
from cedar_auth_plugin import CedarAuthPlugin

plugin = CedarAuthPlugin(
    policies=Path("./cedar/policies.cedar"),
    entities=Path("./cedar/entities.json"),
    resource_resolver="./resources.json",
)
```

`policies.cedar`:
```cedar
permit (
    principal in Team::"cloud_platform",
    action == Action::"use_tool::terminate_ec2_instance",
    resource
) when {
    resource.account_id in principal.managed_accounts
};
```

`entities.json`:
```json
[
    {"uid": {"type": "Team", "id": "cloud_platform"}, "attrs": {"managed_accounts": ["111111111111", "222222222222"]}, "parents": []},
    {"uid": {"type": "User", "id": "alice"}, "attrs": {}, "parents": [{"type": "Team", "id": "cloud_platform"}]}
]
```

The `policies` parameter accepts a `Path` (any extension) or a string ending in `.cedar` to load from file. Any other string is treated as inline Cedar. The `entities` parameter similarly accepts a file path (loaded as JSON) or a list/callable.

**Custom principal resolver:**

The `principal_resolver` parameter accepts either a dict or a function. The dict form mirrors the builder's `.principal(key, type)`.

```python
# Dict form
principal_resolver={"key": "iam_role", "type": "IamRole"}

# Function form — principal type depends on who's calling
def resolve_any(state):
    if "iam_role" in state:
        return f'IamRole::"{state["iam_role"]}"'
    elif "service_name" in state:
        return f'Service::"{state["service_name"]}"'
    return f'User::"{state["user_id"]}"'
```

**Full example with all features:**

```python
plugin = CedarAuthPlugin(
    policies=Path("./cedar/policies.cedar"),
    entities=my_entity_provider,         # callable, list, or file path
    principal_resolver=resolve_any,
    resource_resolver={                   # or "./resources.json"
        "terminate_ec2_instance": {"key": "instance_id", "type": "Instance"},
    },
)

agent = Agent(plugins=[plugin], tools=[...])
agent("terminate instance i-abc123", invocation_state={"user_id": "alice@acme.com"})
```

</details>

<details>
<summary><strong>Appendix I: Cedar vs. OPA</strong></summary>

OPA (Open Policy Agent) with Rego is the most widely adopted policy engine — battle-tested, Kubernetes-native, huge ecosystem. It's the obvious alternative.

| | Cedar | OPA / Rego |
|-|-------|-----------|
| **Language** | Purpose-built for authorization. `principal`, `action`, `resource`, `context` are language primitives. | General-purpose policy language. Authorization concepts are conventions on `input`, not language primitives. Also used for admission control, data filtering, config validation. |
| **Formal verification** | Yes. Can mathematically prove "no intern can reach `delete_record` in production." | No. OPA evaluates queries — it can't reason about the policy set as a whole. |
| **Evaluation guarantees** | Bounded-latency. No recursion, no loops, no user-defined functions. Every evaluation terminates in bounded time. | Rego allows recursion and comprehensions. Evaluation time depends on policy complexity. |
| **Readability** | `permit(principal in Role::"admin", action, resource)` reads like English. | `allow { some role in input.roles; role == "admin" }` — functional, but requires learning Rego syntax. |
| **WASM story** | Rust core compiles to WASM natively via `wasm-bindgen`. Same crate backs Python (PyO3), JS/TS (WASM), or any WASM host. | First-class WASM support (Go → WASM). Production-tested. Slightly more mature WASM ecosystem today. |
| **Managed service** | Cedar → Amazon Verified Permissions (AVP). Same policies, hosted by AWS, CloudTrail integration. | OPA → Styra DAS (commercial SaaS). No AWS-native equivalent. |
| **Community** | ~1.4k GitHub stars. Smaller ecosystem, fewer tutorials, less third-party tooling. Backed by AWS/Amazon. | ~11.5k GitHub stars. CNCF graduated project. Large ecosystem, extensive integrations, broad production adoption. |

**Why is OPA so much more widely used?** OPA launched in 2016 (Cedar in 2023), solves a broader problem (general-purpose policy, not just authorization), and is CNCF cloud-neutral rather than AWS-associated. Its ecosystem advantage is real — but for the narrow question of "can this user call this tool," Cedar's purpose-built authorization model, formal verification, and bounded evaluation are a better fit than OPA's general-purpose power.

**Would we build an OPA plugin?** The plugin architecture (hook into `BeforeToolCallEvent`, evaluate policy, cancel on deny) is engine-agnostic. An `OpaAuthPlugin` would replace Cedar evaluation with OPA/WASM evaluation and Rego policies. The main loss would be formal verification and the builder's ability to generate statically analyzable policies. We'd welcome it as a community contribution or build it ourselves if there's demand.

</details>

<details>
<summary><strong>Appendix J: Cedar Under the Hood</strong></summary>

Strands concepts map onto Cedar's authorization model:

```
┌─────────────────────┬──────────────────────────────────────────┐
│ Cedar Concept        │ Strands Mapping                          │
├─────────────────────┼──────────────────────────────────────────┤
│ Principal            │ The end user (or service identity)       │
│                      │ invoking the agent                       │
├─────────────────────┼──────────────────────────────────────────┤
│ Action               │ One Cedar action per tool, auto-generated│
│                      │ from the tool's name (e.g.,              │
│                      │ Action::"use_tool::delete_record")       │
├─────────────────────┼──────────────────────────────────────────┤
│ Resource             │ The target of the tool call — could be   │
│                      │ the tool itself, or a domain object      │
│                      │ extracted from tool arguments             │
├─────────────────────┼──────────────────────────────────────────┤
│ Context              │ Tool input arguments + session metadata   │
│                      │ (timestamp, conversation ID, agent name)  │
├─────────────────────┼──────────────────────────────────────────┤
│ Entities             │ User/role hierarchy + tool groups,        │
│                      │ supplied by the application or an         │
│                      │ entity provider callback                  │
└─────────────────────┴──────────────────────────────────────────┘
```

**Example policies:**

```cedar
// Allow analysts to search, deny destructive operations
permit (
  principal in Role::"analyst",
  action in Action::"use_tool::search_documents",
  resource
);

forbid (
  principal,
  action in Action::"use_tool::delete_record",
  resource
) when {
  context.environment == "production"
};
```

**Builder-to-Cedar mapping:**

| Builder method | Generated Cedar |
|---------------|----------------|
| `.role("admin", ["*"])` | `permit (principal in Role::"admin", action, resource);` |
| `.role("analyst", ["search", "query_database"])` | `permit (principal in Role::"analyst", action in [Action::"use_tool::search", Action::"use_tool::query_database"], resource);` |
| `.restrict("query_database", {"database": ["analytics", "reporting"]})` | `forbid (principal, ...) when { !(context.database == "analytics" \|\| context.database == "reporting") };` — applies to all roles |
| `.restrict("query_database", {"database": [...]}, for_role="analyst")` | `forbid (principal in Role::"analyst", ...) when { ... };` — only restricts analysts, other roles unaffected |
| `.rate_limit("send_email", max_per_session=3)` | `forbid (...) when { context.session_call_count >= 3 };` (plugin tracks counter, passes it as context) |
| `.time_window(9, 17)` | `forbid (...) when { context.hour_utc < 9 \|\| context.hour_utc >= 17 };` |
| `.deny_tools_in_env("production", [...])` | `forbid (...) when { context.environment == "production" };` |

</details>

<details>
<summary><strong>Appendix K: References</strong></summary>

| # | Source | Relevance to this document |
|---|--------|---------------------------|
| 1 | [Cedar: A New Language for Expressive, Fast, Safe, and Analyzable Authorization](https://www.amazon.science/publications/cedar-a-new-language-for-expressive-fast-safe-and-analyzable-authorization) — Emina Torlak et al., Amazon | The original Cedar paper. Establishes the formal semantics, decidability guarantees, and machine-checked proofs (Lean 4) that underpin this plugin's "formally verifiable" claims. |
| 2 | [How we built Cedar with automated reasoning and differential testing](https://www.amazon.science/blog/how-we-built-cedar-with-automated-reasoning-and-differential-testing) — Amazon Science, 2024 | Details the Lean formalization and differential random testing that prove Cedar's evaluator is correct — when it says Allow or Deny, that answer is mathematically sound. Backs up the verification section. |
| 3 | [Can your governance keep pace with your AI ambitions? AI risk intelligence in the agentic era](https://aws.amazon.com/blogs/machine-learning/can-your-governance-keep-pace-with-your-ai-ambitions-ai-risk-intelligence-in-the-agentic-era/) — Dessertine-Panhard et al., AWS GenAI Innovation Center, 2026 | Identifies "access controls weren't continuously validated while the agent was running" as a root cause of cascading agent failures. Validates runtime per-tool-call authorization over static permission grants. |
| 4 | [Agentic AI in the Enterprise Part 2: Guidance by Persona](https://aws.amazon.com/blogs/machine-learning/operationalizing-agentic-ai-part-2-a-stakeholders-guide/) — Bhasin & Elaprolu, AWS GenAI Innovation Center, 2026 | CISO guidance: treat agents like colleagues with non-human identities, per-tool audit trails, and policy enforcement "at the tool level, not just in the agent's prompt." Reads as a requirements doc for this plugin. |
| 5 | [Introducing Cedar Analysis: Open Source Tools for Verifying Authorization Policies](https://aws.amazon.com/blogs/opensource/introducing-cedar-analysis-open-source-tools-for-verifying-authorization-policies/) — AWS Open Source Blog | Covers Cedar's policy analysis capabilities including partial evaluation (residual policies for missing context), which maps to the `Interrupt` action in our middleware model. |
| 6 | [Secure AI agents with Policy in Amazon Bedrock AgentCore](https://aws.amazon.com/blogs/machine-learning/secure-ai-agents-with-policy-in-amazon-bedrock-agentcore/) — Srinivasan, Nadiminti & Dua, AWS, 2026 | The managed AWS implementation of Cedar-based agent authorization. Enforces Cedar policies at the AgentCore Gateway before tool execution — identity-scoped access, time-based restrictions, natural-language-to-Cedar generation. Validates the core pattern this plugin implements at the framework level: same principal/action/resource/context model, same default-deny + forbid-wins semantics, same separation of policy from agent code. |
| 7 | [AI agents in enterprises: Best practices with Amazon Bedrock AgentCore](https://aws.amazon.com/blogs/machine-learning/ai-agents-in-enterprises-best-practices-with-amazon-bedrock-agentcore/) — Ladeira Tanke & Vasilakakis, AWS, 2026 | "Scale securely with personalization" describes the full auth flow: identity provider → OAuth claims → AgentCore Policy evaluates per-user/per-tool/per-parameter before execution. This is the managed infrastructure version of our framework-level plugin. The multi-agent section also validates `invocation_state` propagation across agent handoffs. |

</details>

