/**
 * SageMaker model provider.
 *
 * Calls OpenAI-compatible inference endpoints (vLLM, TGI, DJL) hosted on
 * Amazon SageMaker through the SageMaker Runtime API.
 *
 * @example
 * ```typescript
 * import { SageMakerModel } from '@strands-agents/sdk/models/sagemaker'
 *
 * const model = new SageMakerModel({
 *   endpointName: 'my-vllm-endpoint',
 *   region: 'us-west-2',
 * })
 * ```
 */

export { SageMakerModel } from './model.js'
export type { SageMakerModelConfig, SageMakerModelOptions } from './types.js'
