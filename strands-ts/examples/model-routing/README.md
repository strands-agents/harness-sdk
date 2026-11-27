# Model routing example

Routes each agent invocation between a fast and an advanced Bedrock model with `ModelRouter` and `ClassifierStrategy`. The script asks one easy and one hard question and prints which model served each.

`ClassifierStrategy` also accepts a `DecisionModel` in place of a model, such as `TypeSafeDecisionModel` or `DecisionsAPIDecisionModel`.

## Prerequisites

- Node.js 22+
- AWS credentials with Bedrock access to `us.amazon.nova-lite-v1:0`, `us.amazon.nova-pro-v1:0`, and `us.anthropic.claude-haiku-4-5-20251001-v1:0`

## Run

```bash
npm install
npm start
```

The SDK is linked from `../../`, so local SDK changes are picked up after `npm run build` in `strands-ts/`.
