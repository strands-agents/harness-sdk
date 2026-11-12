Defined in: [src/types/messages.ts:806](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L806)

Data for a summary block.

## Properties

### provider?

```ts
provider?: string;
```

Defined in: [src/types/messages.ts:810](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L810)

Name of the provider that wrote the summary server-side, for example `'anthropic'`.

---

### signature?

```ts
signature?: string;
```

Defined in: [src/types/messages.ts:815](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L815)

Signature the provider returned with the summary, sent back unchanged.

---

### text

```ts
text: string;
```

Defined in: [src/types/messages.ts:820](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L820)

The summary text.