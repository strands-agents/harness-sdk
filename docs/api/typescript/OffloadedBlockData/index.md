Defined in: [src/types/messages.ts:299](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L299)

**`Experimental`**

Data for an offloaded block, as its constructor takes it. Serialization groups everything but the text under an `offloaded` key, so these names stay free for [TextBlockData](/docs/api/typescript/TextBlockData/index.md).

## Extends

-   [`TextBlockData`](/docs/api/typescript/TextBlockData/index.md)

## Properties

### text

```ts
text: string;
```

Defined in: [src/types/messages.ts:253](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L253)

**`Experimental`**

Plain text content.

#### Inherited from

[`TextBlockData`](/docs/api/typescript/TextBlockData/index.md).[`text`](/docs/api/typescript/TextBlockData/index.md#text)

---

### method

```ts
method: OffloadMethod;
```

Defined in: [src/types/messages.ts:303](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L303)

**`Experimental`**

Offload method that left the placeholder.

---

### ref?

```ts
ref?: string;
```

Defined in: [src/types/messages.ts:308](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L308)

**`Experimental`**

Stash reference under which the original is retrievable; absent when it was not stashed.

---

### tokens?

```ts
tokens?: number;
```

Defined in: [src/types/messages.ts:314](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/types/messages.ts#L314)

**`Experimental`**

Size of the content this placeholder stands for, in tokens, including any placeholder it replaced; absent when the token count could not measure it.