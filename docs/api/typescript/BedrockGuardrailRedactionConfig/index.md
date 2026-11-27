Defined in: [src/models/bedrock.ts:203](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L203)

Redaction configuration for Bedrock guardrails. Controls whether and how blocked content is replaced.

## Properties

### input?

```ts
input?: boolean;
```

Defined in: [src/models/bedrock.ts:205](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L205)

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

Defined in: [src/models/bedrock.ts:208](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L208)

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

Defined in: [src/models/bedrock.ts:211](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L211)

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

Defined in: [src/models/bedrock.ts:214](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L214)

Replacement message for redacted output.

#### Default Value

```ts
'[Assistant output redacted.]'
```