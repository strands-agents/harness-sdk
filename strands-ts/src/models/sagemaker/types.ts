/**
 * Type definitions for the SageMaker model provider.
 */

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
   * Additional payload parameters passed through to the model endpoint.
   * @see https://bit.ly/djl-lmi-request-schema
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
   * AWS region of the endpoint. Falls back to `AWS_REGION` env var, then `us-west-2`.
   */
  region?: string

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
   * Additional parameters to pass to the SageMaker Runtime `InvokeEndpoint` / `InvokeEndpointWithResponseStream` API.
   */
  additionalRequestArgs?: Record<string, unknown>
}

/**
 * Options for constructing a {@link SageMakerModel}.
 */
export interface SageMakerModelOptions extends SageMakerModelConfig, SageMakerEndpointConfig {
  /**
   * Pre-built SageMaker Runtime client. When provided, `region` is ignored.
   * Cannot be combined with `clientConfig`.
   */
  client?: import('@aws-sdk/client-sagemaker-runtime').SageMakerRuntimeClient

  /**
   * Configuration passed to the SageMaker Runtime client constructor.
   * Cannot be combined with `client`.
   */
  clientConfig?: import('@aws-sdk/client-sagemaker-runtime').SageMakerRuntimeClientConfig
}
