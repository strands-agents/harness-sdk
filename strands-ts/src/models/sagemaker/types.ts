/**
 * Type definitions for the SageMaker model provider.
 */

import type {
  InvokeEndpointCommandInput,
  SageMakerRuntimeClient,
  SageMakerRuntimeClientConfig,
} from '@aws-sdk/client-sagemaker-runtime'
import type { BaseModelConfig } from '../model.js'

/**
 * Configuration for the SageMaker model provider.
 */
export interface SageMakerModelConfig extends BaseModelConfig {
  /**
   * Maximum number of tokens to generate.
   */
  maxTokens?: number

  /**
   * Sampling temperature.
   */
  temperature?: number

  /**
   * Nucleus sampling parameter.
   */
  topP?: number

  /**
   * Top-k sampling parameter.
   */
  topK?: number

  /**
   * Whether to stream responses. Defaults to `true`.
   * Set to `false` for endpoints that do not support streaming.
   */
  stream?: boolean

  /**
   * Stop sequences.
   */
  stop?: string[]

  /**
   * When `true`, tool results are sent as user messages instead of `tool`-role messages.
   * Useful for endpoints that reject the `tool` role (e.g. certain TGI configurations).
   *
   * @defaultValue false
   */
  toolResultsAsUserMessages?: boolean

  /**
   * Other request body fields, for parameters the container accepts beyond the ones above (for example
   * `repetition_penalty`, or `stream_options: null` for a container that rejects the field). The fields
   * this provider manages (`messages`, `stream`, sampling settings, `tools`) win.
   *
   * @see https://docs.djl.ai/master/docs/serving/serving/docs/lmi/user_guides/chat_input_output_schema.html
   */
  additionalPayloadArgs?: Record<string, unknown>
}

/**
 * Endpoint-level configuration for a SageMaker model.
 */
export interface SageMakerEndpointConfig {
  /**
   * Name of the SageMaker endpoint to invoke.
   */
  endpointName: string

  /**
   * Inference component name, for multi-model endpoints.
   */
  inferenceComponentName?: string

  /**
   * Target model identifier, for multi-model endpoints with TargetModel routing.
   */
  targetModel?: string

  /**
   * Target variant name.
   */
  targetVariant?: string

  /**
   * Other `InvokeEndpoint` / `InvokeEndpointWithResponseStream` parameters, such as `CustomAttributes`
   * or `SessionId`. The fields this provider sets (endpoint, body, content types, routing) win.
   */
  additionalRequestArgs?: Partial<Omit<InvokeEndpointCommandInput, 'Body' | 'EndpointName'>>
}

/**
 * Options for constructing a {@link SageMakerModel}.
 */
export interface SageMakerModelOptions extends SageMakerModelConfig, SageMakerEndpointConfig {
  /**
   * AWS region of the endpoint. Takes precedence over `clientConfig.region`, then `AWS_REGION`,
   * then `us-west-2`. Cannot be combined with `client`.
   */
  region?: string

  /**
   * Pre-built SageMaker Runtime client, used as is. Cannot be combined with `region` or `clientConfig`.
   */
  client?: SageMakerRuntimeClient

  /**
   * Configuration passed to the SageMaker Runtime client constructor. Cannot be combined with `client`.
   */
  clientConfig?: SageMakerRuntimeClientConfig
}
