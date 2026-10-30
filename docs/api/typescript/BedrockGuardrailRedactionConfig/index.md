Defined in: [src/models/bedrock.ts:187](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L187)

Redaction configuration for Bedrock guardrails. Controls whether and how blocked content is replaced.

## Properties

### input?

```ts
input?: boolean;
```

Defined in: [src/models/bedrock.ts:189](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L189)

Redact input when blocked.

#### Default Value

```ts
true
```

---

### inputMessage?

```ts
inputMessage?: string;
```

Defined in: [src/models/bedrock.ts:192](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L192)

Replacement message for redacted input.

#### Default Value

```ts
'[User input redacted.]'
```

---

### output?

```ts
output?: boolean;
```

Defined in: [src/models/bedrock.ts:195](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L195)

Redact output when blocked.

#### Default Value

```ts
false
```

---

### outputMessage?

```ts
outputMessage?: string;
```

Defined in: [src/models/bedrock.ts:198](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L198)

Replacement message for redacted output.

#### Default Value

```ts
'[Assistant output redacted.]'
```