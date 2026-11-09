Defined in: [src/models/bedrock.ts:377](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L377)

Options for creating a BedrockModel instance.

## Extends

-   [`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md)

## Properties

### maxTokens?

```ts
maxTokens?: number;
```

Defined in: [src/models/bedrock.ts:276](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L276)

Maximum number of tokens to generate in the response.

#### Default Value

the model’s `maxOutputTokens` from the model info when known; otherwise `maxTokens` is not sent and Bedrock’s per-model default applies.

#### See

[https://docs.aws.amazon.com/bedrock/latest/APIReference/API\_runtime\_InferenceConfiguration.html](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_InferenceConfiguration.html)

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`maxTokens`](/docs/api/typescript/BedrockModelConfig/index.md#maxtokens)

---

### temperature?

```ts
temperature?: number;
```

Defined in: [src/models/bedrock.ts:283](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L283)

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

Defined in: [src/models/bedrock.ts:290](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L290)

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

Defined in: [src/models/bedrock.ts:295](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L295)

Array of sequences that will stop generation when encountered.

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`stopSequences`](/docs/api/typescript/BedrockModelConfig/index.md#stopsequences)

---

### cacheConfig?

```ts
cacheConfig?: CacheConfig;
```

Defined in: [src/models/bedrock.ts:302](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L302)

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

Defined in: [src/models/bedrock.ts:307](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L307)

Additional fields to include in the Bedrock request.

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`additionalRequestFields`](/docs/api/typescript/BedrockModelConfig/index.md#additionalrequestfields)

---

### additionalResponseFieldPaths?

```ts
additionalResponseFieldPaths?: string[];
```

Defined in: [src/models/bedrock.ts:312](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L312)

Additional response field paths to extract from the Bedrock response.

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`additionalResponseFieldPaths`](/docs/api/typescript/BedrockModelConfig/index.md#additionalresponsefieldpaths)

---

### additionalArgs?

```ts
additionalArgs?: JSONValue;
```

Defined in: [src/models/bedrock.ts:318](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L318)

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

Defined in: [src/models/bedrock.ts:328](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L328)

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

Defined in: [src/models/bedrock.ts:336](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L336)

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

Defined in: [src/models/bedrock.ts:342](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L342)

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

Defined in: [src/models/bedrock.ts:353](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L353)

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

Defined in: [src/models/bedrock.ts:371](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L371)

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

Defined in: [src/models/bedrock.ts:381](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L381)

AWS region to use for the Bedrock service.

---

### clientConfig?

```ts
clientConfig?: BedrockRuntimeClientConfig;
```

Defined in: [src/models/bedrock.ts:386](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L386)

Configuration for the Bedrock Runtime client.

---

### requestTimeout?

```ts
requestTimeout?: number;
```

Defined in: [src/models/bedrock.ts:397](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L397)

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

Defined in: [src/models/bedrock.ts:404](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/bedrock.ts#L404)

Amazon Bedrock API key for bearer token authentication. When provided, requests use the API key instead of SigV4 signing.

#### See

[https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)

---

### modelId?

```ts
modelId?: string;
```

Defined in: [src/models/model.ts:205](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L205)

The model identifier. This typically specifies which model to use from the provider’s catalog.

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`modelId`](/docs/api/typescript/BedrockModelConfig/index.md#modelid)

---

### contextWindowLimit?

```ts
contextWindowLimit?: number;
```

Defined in: [src/models/model.ts:236](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L236)

Maximum context window size in tokens for the model.

The same fact as `modelInfo.limits.contextWindow`; setting it here is shorthand for setting it through `modelInfo`, and it wins over the shared model info. When both are set, `modelInfo` wins. When not provided, vended providers still populate it from the shared model info for callers that read `getConfig()`; `modelInfo` is the resolved view to read.

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`contextWindowLimit`](/docs/api/typescript/BedrockModelConfig/index.md#contextwindowlimit)

---

### modelInfo?

```ts
modelInfo?: ModelInfo;
```

Defined in: [src/models/model.ts:244](https://github.com/strands-agents/harness-sdk/blob/main/strands-ts/src/models/model.ts#L244)

Overrides for what the SDK knows about the model. Fields set here win over the shared model info and the provider; `capabilities.stateful` changes how the agent loop sends history, so set it only for a provider that keeps state server-side. `updateConfig({ modelInfo })` replaces the previous override entirely, it does not merge into it.

#### Inherited from

[`BedrockModelConfig`](/docs/api/typescript/BedrockModelConfig/index.md).[`modelInfo`](/docs/api/typescript/BedrockModelConfig/index.md#modelinfo)