# Shared

What both SDKs must agree on: data, constants and lists that exist in Python and TypeScript alike. Anything in this folder has a copy or loader in each SDK and a parity test that fails when a copy drifts.

## `model-info.json`

What the SDKs know about models: context windows, output ceilings, which models take cache points, which can be forced to call a tool, which have native structured output, which accept temporary messages, and the id rules that map a provider's model id to the entry that describes it. Each entry is a `ModelInfo`, the same type the SDK exposes, plus the few fields only the harness reads (`capabilities.defaultEffort`); every field is optional and a missing field means unknown.

Edit the file; each SDK copies it into its own package when it installs and builds, and does not commit the copy:

- `strands-ts`: the `prepare` (any `npm ci` / `npm install`) and `prebuild` scripts `cp` it to `strands-ts/src/models/model-info.json` (git-ignored). Run `npm run prepare -w strands-ts` after editing to refresh it. `model-info.test.node.ts` asserts the copy equals this file.
- `strands-py`: the `hatch_build.py` build hook copies it to `strands-py/src/strands/models/model_info.json` (git-ignored). `test__model_info.py` asserts the copy equals this file.

Each consumer reads only the fields it uses and skips the rest, so a field one consumer needs (the harness's `capabilities.defaultEffort`) needs no change in the others.

### Format

Keys and multi-word values are camelCase, matching the TypeScript `ModelInfo` type (`cachePoints`); the Python loader re-cases both on read (`cache_points`). There is no version field: the shape is the SDK's `ModelInfo` type, each SDK's tests validate every entry strictly against it and the named harness-only fields, and a shape change updates the loaders in the same PR. `capabilities.stateful` is owned by the provider and is not read from this file. `capabilities.temporaryMessages` says which models accept temporary messages; only a provider that can send them acts on it.

- `defaults`: what the SDK assumes when a model's entry does not say, today `limits.contextWindow`. Defaults are the SDK's policy, not a fact about any model, so they live apart from `models`.
- `models`: one entry per model, keyed by the shortest id that names it (`claude-opus-5-5`, `gpt-5.4`, `amazon.nova-pro-v1:0`). A lookup tries the id as given, then without a trailing Bedrock version suffix (`-v1:0`), then without a trailing date (`-20260401`, `@20251001`), then with leading dot-separated segments removed one at a time. So `us.anthropic.claude-opus-5-5-20260401-v1:0`, an ARN and `claude-opus-5-5` all resolve to the one `claude-opus-5-5` entry. Add a separate entry only when the same model differs between providers (`openai.gpt-6.1-sol` on Bedrock). Fields: `limits.contextWindow` and `limits.maxOutputTokens` in tokens; `capabilities` as in `ModelInfo`. A model the file does not list is unknown: the SDK uses its defaults for it, so new ids need an entry.
- `capabilities.defaultEffort`: the effort the vendor's own agent harness runs the model at by default (Claude Code, Codex, Gemini CLI), in the vendor's level names; the vendor's documented API default when it has no harness or the harness does not cover the model. Leave it out when neither is documented. Sources as of 2026-11: [Claude Code model config](https://code.claude.com/docs/en/model-config) (`high`, except `medium` for the 5.5 models and `xhigh` for Opus 4.7), Codex's bundled `codex-rs/models-manager/models.json` (`default_reasoning_level`), and Gemini CLI's `packages/core/src/config/defaultModelConfigs.ts` (`thinkingLevel: HIGH` for the Gemini 3.x models it lists). It is for the harness, which reads its own copy of this file to resolve `effort="auto"` (#4683); the SDKs skip it. Values are the harness effort levels: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

## `conformance.json`

Which model behaviors the SDKs check against live models, and on which models. Each SDK's integration tests read this file directly from the repository; it is not copied into a package.

- `cases`: one entry per conformance case, keyed by its id. `passes` says what the case must show. `requires` names a `ModelInfo` field (`capabilities.promptCaching`); the case applies to a model only when that field is known on the model's resolved model info, and equal to `equals` when the case gives one. A case without `requires` applies to every target. The gate reads the resolved info, not `model-info.json`, so a provider that turns a capability off is not asked to show it.
- `targets`: the provider and model id pairs every case runs on. `provider` is a shared id (`anthropic`, `bedrock`, `mantle`, `mantle-responses`, `openai`, `openai-responses`, `gemini`, `mistral`) that each SDK maps to one of its model classes. To cover a new model, add its entry to `model-info.json` and a row here.

Every SDK implements every case and maps every provider, or lists the ones it leaves out with a reason; a test in each SDK fails when a case id or provider id here is in neither list.

### Results

When `STRANDS_CONFORMANCE_RESULTS` names a file, each run appends one JSON object per line to it, one per case and target:

```json
{"sdk": "python", "provider": "anthropic", "model": "claude-opus-5-5", "case": "prompt-caching", "status": "passed"}
```

- `sdk`: `python` or `typescript`.
- `status`: `passed`, `failed`, `error` (the provider could not serve the call: throttling, credentials, an outage, a model that is not served), `skipped` (the case applies but did not run, for example missing credentials) or `not-applicable` (the case's `requires` does not hold for the model, or the SDK leaves the case or provider out). Only `failed` is a verdict against the model; report `error` and `skipped` as not validated.
- `reason`: present for `error`, `skipped` and `not-applicable`.

When a line repeats an earlier `sdk`, `provider`, `model` and `case`, the later line wins.
