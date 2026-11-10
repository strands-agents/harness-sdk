/**
 * Centralized SSM Parameter Store resolution for integration tests.
 */

import { SSMClient, GetParametersCommand, GetParameterCommand } from '@aws-sdk/client-ssm'

import { AWS_REGION } from './_aws.js'

/**
 * Batch-reads SSM parameters by name and returns a key→value map.
 * Parameters that don't exist in SSM resolve to `undefined`.
 */
export async function getSSMParameters<T extends Record<string, string>>(
  params: T
): Promise<{ [K in keyof T]: string | undefined } | null> {
  const client = new SSMClient({ region: AWS_REGION })
  try {
    const response = await client.send(new GetParametersCommand({ Names: Object.values(params) }))
    const byName = new Map((response.Parameters ?? []).map((p) => [p.Name, p.Value]))
    return Object.fromEntries(Object.entries(params).map(([key, name]) => [key, byName.get(name)])) as {
      [K in keyof T]: string | undefined
    }
  } catch (e) {
    console.warn('Error retrieving SSM parameters', e)
    return null
  }
}

/**
 * Read a single SSM parameter, optionally with decryption for SecureString values.
 */
export async function getSSMParameter(name: string, withDecryption = false): Promise<string | undefined> {
  const client = new SSMClient({ region: AWS_REGION })
  try {
    const response = await client.send(new GetParameterCommand({ Name: name, WithDecryption: withDecryption }))
    return response.Parameter?.Value
  } catch (e) {
    console.warn(`Error reading SSM parameter ${name}`, e)
    return undefined
  }
}
