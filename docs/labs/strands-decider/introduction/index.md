System One models understand natural language and make a decision based on that information. They do not generate text — they return a typed answer from a known output space along with a calibrated confidence. The output space is fixed before the request and the model produces a single output token, so Decider is cheaper and faster than asking an LLM to decide.

Strands Decider is a System One model. It takes a **state** — the text (and optionally images) you want a decision about — and one or more typed questions, and answers each one. Three question types are supported: **Choice**, **Noul** (yes/no), and **Score**.

## When to use Decider

Reach for Decider when the output space is known before the request and the same kind of decision happens repeatedly: classification, yes/no, and ranked scoring are the archetypes. Common uses:

-   **Replacing LLM decisions with Decider.** LLMs are good at decisions but costly and slow for the job. Decider often responds in under one second and, because it produces a single output token, you don’t pay for output tokens. See [Amazon saves millions replacing Sonnet with Strands Decider](https://strandsagents.com/blog/amazon-saves-millions-replacing-sonnet-with-strands-decider/).
-   **Model routing.** Route an incoming question to the right-size model — Haiku for easy, Opus for hard. See [Decision models in the Strands SDK](https://strandsagents.com/docs/user-guide/sdk/decision-models/).
-   **Interventions.** Decide whether a human should review an agent’s next action before it happens.
-   **Filtering.** Inside a graph, decide whether a request should go to an LLM (expensive) or be skipped.
-   **Non-agentic classification.** Score support tickets, triage incoming email, or tag documents into fixed categories without wiring up an agent.

Use an LLM, not Decider, when the task needs generated text, conversation, coding, summarization, or complex reasoning. Decider classifies and scores; it does not generate a response.

## Question types

### Choice

Given a list of options, pick one.

> **Example**
> 
> *State:* “What color is this fruit: Banana”
> 
> *Choices:* Red, Yellow, or Blue?
> 
> *Strands Decider:* **Yellow**

### Noul (yes / no)

Ask a yes-or-no question. **Noul** stands for *null-or-one*: Decider returns a single probability in `[0, 1]` that the answer is yes. Read it as “yes” above a threshold you pick for the task (0.5 is the natural default; raise it when a false yes is costly, lower it when a false no is).

> **Example**
> 
> *State:* “Help! My payouts have been failing for 3 days.”
> 
> *Question:* Is this request urgent?
> 
> *Strands Decider:* `noul = 0.94` → yes

### Score

Rate something on an ordered scale. Decider returns an expected value along the scale — a continuous number, not a label — plus the probability of each level and overall confidence.

> **Example**
> 
> *State:* “Order #4421 never arrived and the tracking link is broken.”
> 
> *Scale:* low (0), medium (1), high (2), critical (3)
> 
> *Strands Decider:* **1.71** (between medium and high), high the most likely level at 0.31.

### Image input

Decider can also answer questions about images: pass up to four base64 images alongside the state, and the model reads them through its vision tower and answers the same three question types. Every v2 model accepts images out of the box. The [Quickstart](/docs/labs/strands-decider/quickstart/index.md#ask-about-an-image) has a runnable example; [designs/images](https://github.com/strands-labs/strands-decider/blob/d427f3cfb43e22afbbfc2675c9df8dfdca739197/designs/images.md) has the full request shape and vision benchmark results.

> Note: on the v1 Qwen3.5 checkpoint, load the server with `serve --vision` (or `ask --image …`) to attach the vision tower. v2 Gemma 4 models don’t need the flag. The other v1 Gemma 4 checkpoints don’t support images.

## Next steps

**Try it:** head to the [Quickstart](/docs/labs/strands-decider/quickstart/index.md) to install, serve, and run your first decision in a few minutes.