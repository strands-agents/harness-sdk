Defined in: [src/decisions/llm-decision-model.ts:34](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/llm-decision-model.ts#L34)

Options for constructing an [LLMDecisionModel](/docs/api/typescript/LLMDecisionModel/index.md).

## Properties

### model?

```ts
readonly model?: Model;
```

Defined in: [src/decisions/llm-decision-model.ts:39](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/llm-decision-model.ts#L39)

Underlying vended model; must honor forced `toolChoice` so the structured-output tool is the only possible response. Defaults to a zero-config [BedrockModel](/docs/api/typescript/BedrockModel/index.md).

---

### systemPrompt?

```ts
readonly systemPrompt?: string;
```

Defined in: [src/decisions/llm-decision-model.ts:45](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/llm-decision-model.ts#L45)

System prompt used to frame the decision for the model. The SDK appends mandatory output and prompt-injection rules that the prompt cannot override. Defaults to a generic decision framing.