/**
 * Shared identifiers for the test infrastructure stack.
 *
 * This module is the single source of truth imported by both the CDK
 * constructs (which create the resources) and the integration tests (which
 * consume them). Keeping the values here means a test never hardcodes a path
 * that can drift from what the stack actually provisions.
 */

/**
 * Independently selectable test features. The stack provisions a feature only
 * when it is selected, so a deployment can stand up just the slice a given test
 * suite needs. `all` selects every feature. Add new features to this array —
 * the type is derived from it automatically.
 */
export const VALID_TEST_FEATURES = ['all', 'bedrock-knowledge-base', 'ssh-ec2'] as const;

export type TestFeature = (typeof VALID_TEST_FEATURES)[number];


/**
 * Root of the SSM parameter namespace the stack writes deploy-time identifiers
 * into. Service-generated IDs (e.g. a knowledge base id) can't be chosen ahead
 * of time, so tests hardcode stable *paths* and resolve the IDs at runtime with
 * a single GetParameter — no name scan, no throttling.
 */
export const SSM_PARAMETER_NAMESPACE = '/strands/test-infra';

/**
 * Build the SSM parameter path for a given feature and parameter name. Both the
 * construct that writes the value and the test that reads it derive the same
 * path from this one function.
 *
 * @example ssmParameterPath('bedrock-knowledge-base', 'knowledge-base-id')
 *          // '/strands/test-infra/bedrock-knowledge-base/knowledge-base-id'
 */
export function ssmParameterPath(feature: TestFeature, ...segments: string[]): string {
  return [SSM_PARAMETER_NAMESPACE, feature, ...segments].join('/');
}
