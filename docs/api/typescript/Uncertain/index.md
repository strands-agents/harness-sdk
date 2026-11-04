Defined in: [src/decisions/types.ts:75](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L75)

Sentinel returned in place of an answer when the decision model declined to commit. Carries an optional free-form reason supplied by the implementation.

## Constructors

### Constructor

```ts
new Uncertain(reason?): Uncertain;
```

Defined in: [src/decisions/types.ts:76](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L76)

#### Parameters

| Parameter | Type |
| --- | --- |
| `reason?` | `string` |

#### Returns

`Uncertain`

## Properties

### reason?

```ts
readonly reason?: string;
```

Defined in: [src/decisions/types.ts:76](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L76)

## Methods

### toString()

```ts
toString(): string;
```

Defined in: [src/decisions/types.ts:78](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L78)

#### Returns

`string`

---

### toJSON()

```ts
toJSON(): {
  uncertain: true;
  reason?: string;
};
```

Defined in: [src/decisions/types.ts:82](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L82)

#### Returns

```ts
{
  uncertain: true;
  reason?: string;
}
```

| Name | Type | Defined in |
| --- | --- | --- |
| `uncertain` | `true` | [src/decisions/types.ts:82](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L82) |
| `reason?` | `string` | [src/decisions/types.ts:82](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/decisions/types.ts#L82) |