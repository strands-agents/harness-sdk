Defined in: [src/decisions/llm-decision-model.ts:35](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/llm-decision-model.ts#L35)

Options for constructing an [LLMDecisionModel](/docs/api/typescript/LLMDecisionModel/index.md).

## Properties

### model?

```ts
readonly model?: Model;
```

Defined in: [src/decisions/llm-decision-model.ts:42](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/llm-decision-model.ts#L42)

Underlying vended model; must honor forced `toolChoice` so the structured-output tool is the only possible response. Defaults to a [BedrockModel](/docs/api/typescript/BedrockModel/index.md) with strict tool use enabled so answers conform to the schema. When passing your own model, enable your provider’s strict mode (e.g. `strictTools: true` on [BedrockModel](/docs/api/typescript/BedrockModel/index.md)).

---

### systemPrompt?

```ts
readonly systemPrompt?: string;
```

Defined in: [src/decisions/llm-decision-model.ts:48](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/llm-decision-model.ts#L48)

System prompt used to frame the decision for the model. The SDK appends mandatory output and prompt-injection rules that the prompt cannot override. Defaults to a generic decision framing.