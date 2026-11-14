# Decision model example

This example asks an LLM-backed decision model to classify two input prompts and
prints each answer, token usage, and call latency. The `color` question uses a
closed set of string choices; `isHeavy` uses boolean choices and requires a
committed answer.

The example constructs a default `BedrockModel`, so configure AWS credentials and
the AWS region required by your Bedrock setup before running it. It makes live
model calls and may incur AWS charges.

From this directory, install the workspace dependencies and run the example:

```bash
npm install
npm start
```

The script compiles the TypeScript example, then runs the generated JavaScript.
Model answers are non-deterministic; the printed choices, token usage, and latency
vary by input and provider response.
