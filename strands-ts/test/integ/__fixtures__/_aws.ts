/**
 * Shared AWS configuration for integration tests.
 */

/** Resolved AWS region for all integ test infrastructure. */
export const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
