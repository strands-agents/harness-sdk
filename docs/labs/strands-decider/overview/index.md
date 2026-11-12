Strands Decider is a small, fast decision model for agentic AI. It answers typed questions about a state instead of generating text. Use it when your application already knows the valid outputs and needs a choice, a yes-or-no probability, or a score with a calibrated measure of confidence.

Decider runs on a local CPU, an Apple-silicon Mac, or an NVIDIA GPU. You can call it from the command line, serve it over HTTP, or place it inside a Strands agent.

## What Decider returns

Decider supports three question types:

| Type | Use it to | Result |
| --- | --- | --- |
| `noul` | Ask a yes-or-no question | The probability that the answer is true |
| `choice` | Pick one option from a set | The selected option, every option’s probability, and confidence |
| `score` | Rate something on an ordered scale | The expected score, the distribution across levels, and confidence |

One request can ask several questions about the same state. Decider encodes the shared state once, then evaluates each question independently. This keeps multi-question decisions fast without letting one question influence another.

## When to use Decider

Use Decider when the output space is known before the request and the same kind of decision happens repeatedly. Common uses inside agentic workflows include:

-   routing a request to a model, tool, team, or queue;
-   checking tool arguments, grounding, safety, or policy compliance;
-   scoring model responses for evaluation;
-   handling routine decisions in a hybrid agent while an LLM handles harder, open-ended work.

Use an LLM when the task needs generated text, conversation, coding, summarization, or complex reasoning. Decider classifies and scores; it does not generate a response.

## Try one decision

Install the package and ask the published 2B model to route a support request:

```bash
pip install strands-decider

strands-decider ask StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 \
  --state "Help! My payouts have been failing for 3 days." \
  --choice "Which team should handle this?=billing,technical,sales"
```

The result names the selected option, reports a probability for every option, and includes a confidence for the choice. See [Inference](../inference/index.md) for the complete installation, device, command-line, and HTTP server guide.

## Explore Decider

-   [Inference](../inference/index.md): install Decider, ask questions, and serve the HTTP API.
-   [Images](../images/index.md): ask questions about image inputs with supported models.
-   [Architecture](../architecture/index.md): understand the pointer head, question types, calibration, and shared-prefix cache.
-   [Model names](../model-names/index.md): choose and interpret a published model identifier.
-   [Strands Agents example](https://github.com/strands-labs/strands-decider/blob/1ace5aaa86a8c59d949ac97810f9f2e3b79a1ff8/examples/strands/README.md): gate a tool call with Decider inside a Strands agent.

New to Decider? Continue with [Inference](../inference/index.md) to run the model locally.