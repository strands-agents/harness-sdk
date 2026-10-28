# Shared

What both SDKs must agree on: data, constants and lists that exist in Python and TypeScript alike. Anything in this folder has a copy or loader in each SDK and a parity test that fails when a copy drifts.

## `model-info.json`

What the SDKs know about models: context windows, output ceilings, which models take cache points, which can be forced to call a tool, which have native structured output, and the id rules that map a provider's model id to the entry that describes it. Each entry is a `ModelInfo`, the same type the SDK exposes; every field is optional and a missing field means unknown.

Edit the file; each SDK copies it into its own package when it installs and builds, and does not commit the copy:

- `strands-ts`: the `prepare` (any `npm ci` / `npm install`) and `prebuild` scripts `cp` it to `strands-ts/src/models/model-info.json` (git-ignored). Run `npm run prepare -w strands-ts` after editing to refresh it. `model-info.test.node.ts` asserts the copy equals this file.
- `strands-py`: a hatch build hook does the same for the Python package (comes with the Python PR).

### Format

Keys and multi-word values are camelCase, matching the TypeScript `ModelInfo` type (`cachePoints`); the Python loader re-cases both on read (`cache_points`). There is no version field: the shape is the SDK's `ModelInfo` type, each SDK's tests validate every entry strictly against it, and a shape change updates the loaders in the same PR. `capabilities.stateful` is owned by the provider and is not read from this file.

- `defaults`: what the SDK assumes when a model's entry does not say, today `limits.contextWindow`. Defaults are the SDK's policy, not a fact about any model, so they live apart from `models`.
- `models`: one entry per model, keyed by the shortest id that names it (`claude-opus-5-5`, `gpt-5.4`, `amazon.nova-pro-v1:0`). A lookup tries the id as given, then without a trailing Bedrock version suffix (`-v1:0`), then without a trailing date (`-20260401`, `@20251001`), then with leading dot-separated segments removed one at a time. So `us.anthropic.claude-opus-5-5-20260401-v1:0`, an ARN and `claude-opus-5-5` all resolve to the one `claude-opus-5-5` entry. Add a separate entry only when the same model differs between providers (`openai.gpt-6.1-sol` on Bedrock). Fields: `limits.contextWindow` and `limits.maxOutputTokens` in tokens; `capabilities` as in `ModelInfo`. A model the file does not list is unknown: the SDK uses its defaults for it, so new ids need an entry.
