```ts
type DeferredToolLoading = "unsupported" | "native" | "stubs";
```

Defined in: [src/models/model-info.ts:25](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model-info.ts#L25)

How a model keeps deferred tool schemas out of its context until it loads them: `'native'` sends them with the API’s own deferral flag, `'stubs'` sends each as its name and description with an open schema, and `'unsupported'` sends every schema.