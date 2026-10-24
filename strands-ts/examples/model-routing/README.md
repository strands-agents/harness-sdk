# Model routing example

Runs `ModelRouter` with `ClassifierStrategy` and `DecisionStrategy` against real Bedrock models. Each scenario prints which model served the first call and whether that matches the expected candidate.

| Scenario                                       | What it checks                                                                                                                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. `ClassifierStrategy`                        | The existing constructor and options still work. Claude Haiku 5.5 classifies; a routine request is served by the small open-weight `gpt-oss-20b` and a design request by Claude Opus 5. |
| 2. `DecisionStrategy` + `LLMDecisionModel`     | Routing works when a small open-weight model (`ministral-3-8b-instruct`) answers the routing question through `LLMDecisionModel`.                                                       |
| 3. `DecisionStrategy` + custom `DecisionModel` | A local keyword model routes without making a classifier call. The script prints the question (positional keys `c0`, `c1`) and the bounded JSON state the decision model receives.      |
| 4. Timeout                                     | A decision model that never answers is aborted through its `signal`, and the router serves candidate `c0`.                                                                              |

## Prerequisites

- Node.js 22+
- AWS credentials with Bedrock access, in a Region that serves all four models, to `global.anthropic.claude-haiku-5-5`, `global.anthropic.claude-opus-5`, `openai.gpt-oss-20b-1:0`, and `mistral.ministral-3-8b-instruct`

## Run

```bash
npm install
npm start
```

The SDK is linked from `../../`, so local SDK changes are picked up after `npm run build` in `strands-ts/`. The script exits non-zero when any check fails. Scenarios 1 and 2 depend on a live classifier, so an occasional mis-route there is model variance, not an SDK failure.
