Defined in: [src/interventions/handler.ts:44](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interventions/handler.ts#L44)

Base class for intervention handlers.

Handlers override the lifecycle methods they care about. Default implementations return Proceed. The framework detects which methods are overridden and only registers hook callbacks for those.

## Example

```typescript
class CedarAuth extends InterventionHandler {
  readonly name = 'cedar-auth'

  override beforeToolCall(event: BeforeToolCallEvent): InterventionAction {
    if (!this.isAuthorized(event)) {
      return deny('User not authorized for this tool')
    }
    return proceed()
  }
}
```

## Constructors

### Constructor

```ts
new InterventionHandler(): InterventionHandler;
```

#### Returns

`InterventionHandler`

## Properties

### name

```ts
abstract readonly name: string;
```

Defined in: [src/interventions/handler.ts:45](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interventions/handler.ts#L45)

---

### onError

```ts
readonly onError: OnError = 'throw';
```

Defined in: [src/interventions/handler.ts:48](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interventions/handler.ts#L48)

What to do when this handler throws. Defaults to ‘throw’.

## Methods

### beforeInvocation()

```ts
beforeInvocation(_event): Awaitable<Proceed | Deny | Guide | Transform>;
```

Defined in: [src/interventions/handler.ts:50](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interventions/handler.ts#L50)

#### Parameters

| Parameter | Type |
| --- | --- |
| `_event` | [`BeforeInvocationEvent`](/docs/api/typescript/BeforeInvocationEvent/index.md) |

#### Returns

`Awaitable`<`Proceed` | `Deny` | `Guide` | `Transform`\>

---

### beforeToolCall()

```ts
beforeToolCall(_event): Awaitable<Proceed | Deny | Guide | Transform | Confirm>;
```

Defined in: [src/interventions/handler.ts:54](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interventions/handler.ts#L54)

#### Parameters

| Parameter | Type |
| --- | --- |
| `_event` | [`BeforeToolCallEvent`](/docs/api/typescript/BeforeToolCallEvent/index.md) |

#### Returns

`Awaitable`<`Proceed` | `Deny` | `Guide` | `Transform` | `Confirm`\>

---

### afterToolCall()

```ts
afterToolCall(_event): Awaitable<Proceed | Transform>;
```

Defined in: [src/interventions/handler.ts:58](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interventions/handler.ts#L58)

#### Parameters

| Parameter | Type |
| --- | --- |
| `_event` | [`AfterToolCallEvent`](/docs/api/typescript/AfterToolCallEvent/index.md) |

#### Returns

`Awaitable`<`Proceed` | `Transform`\>

---

### beforeModelCall()

```ts
beforeModelCall(_event): Awaitable<Proceed | Deny | Guide | Transform>;
```

Defined in: [src/interventions/handler.ts:62](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interventions/handler.ts#L62)

#### Parameters

| Parameter | Type |
| --- | --- |
| `_event` | [`BeforeModelCallEvent`](/docs/api/typescript/BeforeModelCallEvent/index.md) |

#### Returns

`Awaitable`<`Proceed` | `Deny` | `Guide` | `Transform`\>

---

### afterModelCall()

```ts
afterModelCall(_event): Awaitable<Proceed | Guide | Transform>;
```

Defined in: [src/interventions/handler.ts:66](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/interventions/handler.ts#L66)

#### Parameters

| Parameter | Type |
| --- | --- |
| `_event` | [`AfterModelCallEvent`](/docs/api/typescript/AfterModelCallEvent/index.md) |

#### Returns

`Awaitable`<`Proceed` | `Guide` | `Transform`\>