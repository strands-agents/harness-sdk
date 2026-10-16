Draft only — not posted.

I have a local Python prototype of option 1, based on `python/v1.59.0`, and would
like feedback on the API before offering a PR.

It adds a thread/loop-safe `Agent.send(...)` inbox and an opt-in
`background_tasks={"wake_on_input": True}`. During wait-for-completion, queued
input wakes a continuation so the parent can respond while background tasks keep
running, then resumes waiting. Ready background results are delivered first,
followed by FIFO user input at the next model boundary. Single-flight invocation
semantics remain unchanged, and sending never starts an idle agent.

For steering sub-agents, background tools can register `ToolContext.on_message`
and report bounded progress through `report_progress`. The manage tool exposes
progress via `get` and routes `message` to a running task. Agent-as-tool adapters
wire this up automatically; custom sub-agent tools can register their own child.
Cancellation and input-required interrupts retain their existing roles. Pending
input, handlers, and live progress are not restored from session state.

I read the closure discussion on #3834 and the replacement proposal #4749. This
is deliberately scoped to input within an active invocation; it does not add
invocation queueing or durable execution. Should its naming/contract converge
with the proposed TS `inject`, and should the Python surface start experimental?
Happy to offer a focused PR once the direction is agreed.
