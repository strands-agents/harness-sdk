Defined in: [src/types/messages.ts:650](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L650)

Data for a summary block.

## Properties

### provider?

```ts
provider?: string;
```

Defined in: [src/types/messages.ts:654](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L654)

Name of the provider that wrote the summary server-side, for example `'anthropic'`.

---

### signature?

```ts
signature?: string;
```

Defined in: [src/types/messages.ts:659](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L659)

Signature the provider returned with the summary, sent back unchanged.

---

### text

```ts
text: string;
```

Defined in: [src/types/messages.ts:664](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L664)

The summary text.