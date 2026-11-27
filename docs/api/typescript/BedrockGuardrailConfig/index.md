Defined in: [src/models/bedrock.ts:222](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L222)

Configuration for Bedrock guardrails.

## See

[https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html)

## Properties

### guardrailIdentifier

```ts
guardrailIdentifier: string;
```

Defined in: [src/models/bedrock.ts:224](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L224)

Guardrail identifier

---

### guardrailVersion

```ts
guardrailVersion: string;
```

Defined in: [src/models/bedrock.ts:227](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L227)

Guardrail version (e.g., “1”, “DRAFT”)

---

### trace?

```ts
trace?: "enabled" | "disabled" | "enabled_full";
```

Defined in: [src/models/bedrock.ts:230](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L230)

Trace mode for evaluation.

#### Default Value

```ts
'enabled'
```

---

### streamProcessingMode?

```ts
streamProcessingMode?: "sync" | "async";
```

Defined in: [src/models/bedrock.ts:233](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L233)

Stream processing mode

---

### redaction?

```ts
redaction?: BedrockGuardrailRedactionConfig;
```

Defined in: [src/models/bedrock.ts:236](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L236)

Redaction behavior when content is blocked

---

### guardLatestUserMessage?

```ts
guardLatestUserMessage?: boolean;
```

Defined in: [src/models/bedrock.ts:250](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L250)

Only evaluate the latest user message with guardrails. When true, wraps the latest user message’s text/image content in guardContent blocks. This can improve performance and reduce costs in multi-turn conversations.

#### Remarks

The implementation finds the last user message containing text or image content (not just the last message), ensuring correct behavior during tool execution cycles where toolResult messages may follow the user’s actual input.

#### Default Value

```ts
false
```