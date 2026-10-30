Defined in: [src/models/bedrock.ts:371](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L371)

Options for creating a BedrockModel instance.

## Extends

-   [`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md)

## Properties

### maxTokens?

```ts
maxTokens?: number;
```

Defined in: [src/models/bedrock.ts:270](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L270)

Maximum number of tokens to generate in the response.

#### See

[https://docs.aws.amazon.com/bedrock/latest/APIReference/API\_runtime\_InferenceConfiguration.html](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InferenceConfiguration.html)

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`maxTokens`](/docs/api/typescript/BedrockModelConfig/index.md#maxtokens)

---

### temperature?

```ts
temperature?: number;
```

Defined in: [src/models/bedrock.ts:277](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L277)

Controls randomness in generation.

#### See

[https://docs.aws.amazon.com/bedrock/latest/APIReference/API\_runtime\_InferenceConfiguration.html](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InferenceConfiguration.html)

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`temperature`](/docs/api/typescript/BedrockModelConfig/index.md#temperature)

---

### topP?

```ts
topP?: number;
```

Defined in: [src/models/bedrock.ts:284](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L284)

Controls diversity via nucleus sampling.

#### See

[https://docs.aws.amazon.com/bedrock/latest/APIReference/API\_runtime\_InferenceConfiguration.html](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InferenceConfiguration.html)

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`topP`](/docs/api/typescript/BedrockModelConfig/index.md#topp)

---

### stopSequences?

```ts
stopSequences?: string[];
```

Defined in: [src/models/bedrock.ts:289](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L289)

Array of sequences that will stop generation when encountered.

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`stopSequences`](/docs/api/typescript/BedrockModelConfig/index.md#stopsequences)

---

### cacheConfig?

```ts
cacheConfig?: CacheConfig;
```

Defined in: [src/models/bedrock.ts:296](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L296)

Configuration for prompt caching.

#### See

[https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html)

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`cacheConfig`](/docs/api/typescript/BedrockModelConfig/index.md#cacheconfig)

---

### additionalRequestFields?

```ts
additionalRequestFields?: JSONValue;
```

Defined in: [src/models/bedrock.ts:301](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L301)

Additional fields to include in the Bedrock request.

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`additionalRequestFields`](/docs/api/typescript/BedrockModelConfig/index.md#additionalrequestfields)

---

### additionalResponseFieldPaths?

```ts
additionalResponseFieldPaths?: string[];
```

Defined in: [src/models/bedrock.ts:306](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L306)

Additional response field paths to extract from the Bedrock response.

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`additionalResponseFieldPaths`](/docs/api/typescript/BedrockModelConfig/index.md#additionalresponsefieldpaths)

---

### additionalArgs?

```ts
additionalArgs?: JSONValue;
```

Defined in: [src/models/bedrock.ts:312](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L312)

Additional arguments to pass through to the Bedrock Converse API.

#### See

[https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/bedrock-runtime/command/ConverseStreamCommand/](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/bedrock-runtime/command/ConverseStreamCommand/)

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`additionalArgs`](/docs/api/typescript/BedrockModelConfig/index.md#additionalargs)

---

### stream?

```ts
stream?: boolean;
```

Defined in: [src/models/bedrock.ts:322](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L322)

Whether or not to stream responses from the model.

This will use the ConverseStream API instead of the Converse API.

#### See

-   [https://docs.aws.amazon.com/bedrock/latest/APIReference/API\_runtime\_Converse.html](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html)
-   [https://docs.aws.amazon.com/bedrock/latest/APIReference/API\_runtime\_ConverseStream.html](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html)

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`stream`](/docs/api/typescript/BedrockModelConfig/index.md#stream)

---

### includeToolResultStatus?

```ts
includeToolResultStatus?: boolean | "auto";
```

Defined in: [src/models/bedrock.ts:330](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L330)

Flag to include status field in tool results.

-   `true`: Always include status field
-   `false`: Never include status field
-   `'auto'`: Automatically determine based on model ID (default)

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`includeToolResultStatus`](/docs/api/typescript/BedrockModelConfig/index.md#includetoolresultstatus)

---

### guardrailConfig?

```ts
guardrailConfig?: BedrockGuardrailConfig;
```

Defined in: [src/models/bedrock.ts:336](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L336)

Guardrail configuration for content filtering and safety controls.

#### See

[https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html](https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails.html)

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`guardrailConfig`](/docs/api/typescript/BedrockModelConfig/index.md#guardrailconfig)

---

### useNativeTokenCount?

```ts
useNativeTokenCount?: boolean;
```

Defined in: [src/models/bedrock.ts:347](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L347)

Whether to use the native Bedrock CountTokens API.

When `true`, `countTokens()` calls the Bedrock CountTokens API for accurate counts. When `false` or not set (default), skips the API call and uses the character-based heuristic estimator.

#### Default Value

```ts
false
```

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`useNativeTokenCount`](/docs/api/typescript/BedrockModelConfig/index.md#usenativetokencount)

---

### strictTools?

```ts
strictTools?: boolean;
```

Defined in: [src/models/bedrock.ts:365](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L365)

Constrain the model to emit tool names and inputs that conform to each tool’s schema.

When `true`, every tool is sent with `strict: true` and a copy of its `inputSchema` with `additionalProperties: false` added to each object type, so a free-form `{ type: 'object' }` parameter becomes one the model can only fill with `{}`. Bedrock rejects schemas that use features outside its strict subset (recursive or external `$ref`, `minimum`/`maximum`/ `multipleOf`, `minLength`/`maxLength`, `additionalProperties` other than `false`) with a 400 at request time, and compiles each new schema on first use, which can take minutes. Incompatible with citations for Anthropic models.

#### See

-   [https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html](https://docs.aws.amazon.com/bedrock/latest/userguide/structured-output.html)
-   [https://docs.aws.amazon.com/bedrock/latest/APIReference/API\_runtime\_ToolSpecification.html](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ToolSpecification.html)

#### Default Value

```ts
false
```

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`strictTools`](/docs/api/typescript/BedrockModelConfig/index.md#stricttools)

---

### region?

```ts
region?: string;
```

Defined in: [src/models/bedrock.ts:375](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L375)

AWS region to use for the Bedrock service.

---

### clientConfig?

```ts
clientConfig?: BedrockRuntimeClientConfig;
```

Defined in: [src/models/bedrock.ts:380](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L380)

Configuration for the Bedrock Runtime client.

---

### requestTimeout?

```ts
requestTimeout?: number;
```

Defined in: [src/models/bedrock.ts:391](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L391)

Milliseconds of stream inactivity before a Bedrock request is aborted.

Applies to the default request handler and takes precedence over `clientConfig.requestHandler.requestTimeout`. Ignored when `clientConfig.requestHandler` is a constructed handler instance, whose own timeouts apply.

#### Default Value

```ts
120000
```

---

### apiKey?

```ts
apiKey?: string;
```

Defined in: [src/models/bedrock.ts:398](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L398)

Amazon Bedrock API key for bearer token authentication. When provided, requests use the API key instead of SigV4 signing.

#### See

[https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)

---

### modelId?

```ts
modelId?: string;
```

Defined in: [src/models/model.ts:189](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L189)

The model identifier. This typically specifies which model to use from the provider’s catalog.

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`modelId`](/docs/api/typescript/BedrockModelConfig/index.md#modelid)

---

### contextWindowLimit?

```ts
contextWindowLimit?: number;
```

Defined in: [src/models/model.ts:220](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L220)

Maximum context window size in tokens for the model.

The same fact as `modelInfo.limits.contextWindow`; setting it here is shorthand for setting it through `modelInfo`, and it wins over the shared model info. When both are set, `modelInfo` wins. When not provided, vended providers still populate it from the shared model info for callers that read `getConfig()`; `modelInfo` is the resolved view to read.

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`contextWindowLimit`](/docs/api/typescript/BedrockModelConfig/index.md#contextwindowlimit)

---

### modelInfo?

```ts
modelInfo?: ModelInfo;
```

Defined in: [src/models/model.ts:228](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L228)

Overrides for what the SDK knows about the model. Fields set here win over the shared model info and the provider; `capabilities.stateful` changes how the agent loop sends history, so set it only for a provider that keeps state server-side. `updateConfig({ modelInfo })` replaces the previous override entirely, it does not merge into it.

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`modelInfo`](/docs/api/typescript/BedrockModelConfig/index.md#modelinfo)