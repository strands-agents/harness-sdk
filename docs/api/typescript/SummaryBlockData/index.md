Defined in: [src/types/messages.ts:869](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L869)

Data for a summary block.

## Properties

### provider?

```ts
provider?: string;
```

Defined in: [src/types/messages.ts:873](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L873)

Name of the provider that wrote the summary server-side, for example `'anthropic'`.

---

### signature?

```ts
signature?: string;
```

Defined in: [src/types/messages.ts:878](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L878)

Signature the provider returned with the summary, sent back unchanged.

---

### text

```ts
text: string;
```

Defined in: [src/types/messages.ts:883](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L883)

The summary text.