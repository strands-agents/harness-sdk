/**
 * Global setup that runs once before all integration tests and possibly runs in the *parent* process.
 *
 * _setup-test on the other hand runs in the *child* process.
 */

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager'
import { fromNodeProviderChain } from '@aws-sdk/credential-providers'
import express from 'express'
import type { TestProject } from 'vitest/node'
import type { ProvidedContext } from 'vitest'

import { Agent } from '../../../src/agent/agent.js'
import { A2AExpressServer } from '../../../src/a2a/express-server.js'
import { BedrockModel } from '../../../src/models/bedrock.js'
import { AWS_REGION } from './_aws.js'
import { getSSMParameters } from './_ssm.js'
import { getSshEc2TestContext } from './_ssh-ec2.js'

/**
 * Load API keys as environment variables from AWS Secrets Manager
 */
async function loadApiKeysFromSecretsManager(): Promise<void> {
  const client = new SecretsManagerClient({
    region: AWS_REGION,
  })

  try {
    const secretName = 'model-provider-api-key'
    const command = new GetSecretValueCommand({
      SecretId: secretName,
    })
    const response = await client.send(command)

    if (response.SecretString) {
      const secret = JSON.parse(response.SecretString)
      // Only add API keys for currently supported providers
      const supportedProviders = ['openai', 'anthropic', 'gemini']
      Object.entries(secret).forEach(([key, value]) => {
        if (supportedProviders.includes(key.toLowerCase())) {
          process.env[`${key.toUpperCase()}_API_KEY`] = String(value)
        }
      })
    }
  } catch (e) {
    console.warn('Error retrieving secret', e)
  }

  /*
   * Validate that required environment variables are set when running in GitHub Actions.
   * This prevents tests from being unintentionally skipped due to missing credentials.
   */
  if (process.env.GITHUB_ACTIONS !== 'true') {
    console.warn('Tests running outside GitHub Actions, skipping required provider validation')
    return
  }

  const requiredProviders: Set<string> = new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'])

  for (const provider of requiredProviders) {
    if (!process.env[provider]) {
      throw new Error(`Missing required environment variables for ${provider}`)
    }
  }
}

/**
 * Perform shared setup for the integration tests.
 */
export async function setup(project: TestProject): Promise<() => void> {
  console.log('Global setup: Loading API keys from Secrets Manager...')
  await loadApiKeysFromSecretsManager()
  console.log('Global setup: API keys loaded into environment')

  const isCI = !!globalThis.process.env.CI

  project.provide('isBrowser', project.isBrowserEnabled())
  project.provide('isCI', isCI)
  project.provide('provider-openai', await getOpenAITestContext(isCI))
  project.provide('provider-bedrock', await getBedrockTestContext(isCI))
  project.provide('provider-bedrock-kb', await getBedrockKnowledgeBaseTestContext())
  project.provide('provider-anthropic', await getAnthropicTestContext(isCI))
  project.provide('provider-gemini', await getGeminiTestContext(isCI))

  const a2aContext = await getA2AServerContext(project)
  project.provide('a2a-server', { shouldSkip: a2aContext.shouldSkip, url: a2aContext.url })

  const sshEc2 = await getSshEc2TestContext(project)
  project.provide('provider-ssh-ec2', sshEc2.context)

  return () => {
    a2aContext.abort?.()
    sshEc2.cleanup()
  }
}

async function getOpenAITestContext(isCI: boolean): Promise<ProvidedContext['provider-openai']> {
  const apiKey = process.env.OPENAI_API_KEY
  const shouldSkip = !apiKey

  if (shouldSkip) {
    console.log('⏭️  OpenAI API key not available - integration tests will be skipped')
    if (isCI) {
      throw new Error('CI/CD should be running all tests')
    }
  } else {
    console.log('⏭️  OpenAI API key available - integration tests will run')
  }

  return {
    apiKey: apiKey,
    shouldSkip: shouldSkip,
  }
}

async function getAnthropicTestContext(isCI: boolean): Promise<ProvidedContext['provider-anthropic']> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  const shouldSkip = !apiKey

  if (shouldSkip) {
    console.log('⏭️  Anthropic API key not available - integration tests will be skipped')
    if (isCI) {
      throw new Error('CI/CD should be running all tests')
    }
  } else {
    console.log('⏭️  Anthropic API key available - integration tests will run')
  }

  return {
    apiKey: apiKey,
    shouldSkip: shouldSkip,
  }
}

async function getBedrockTestContext(isCI: boolean): Promise<ProvidedContext['provider-bedrock']> {
  try {
    const credentialProvider = fromNodeProviderChain()
    const credentials = await credentialProvider()
    console.log('⏭️  Bedrock credentials available - integration tests will run')
    return {
      shouldSkip: false,
      credentials: credentials,
    }
  } catch {
    console.log('⏭️  Bedrock credentials not available - integration tests will be skipped')
    if (isCI) {
      throw new Error('CI/CD should be running all tests')
    }
    return {
      shouldSkip: true,
      credentials: undefined,
    }
  }
}

async function getBedrockKnowledgeBaseTestContext(): Promise<ProvidedContext['provider-bedrock-kb']> {
  const skip = (): ProvidedContext['provider-bedrock-kb'] => ({
    shouldSkip: true,
    knowledgeBaseId: undefined,
    customDataSourceId: undefined,
    s3DataSourceId: undefined,
    s3Bucket: undefined,
  })

  const resolved = await getSSMParameters({
    knowledgeBaseId: '/strands/test-infra/bedrock-knowledge-base/knowledge-base-id',
    customDataSourceId: '/strands/test-infra/bedrock-knowledge-base/custom-data-source-id',
    s3DataSourceId: '/strands/test-infra/bedrock-knowledge-base/s3-data-source-id',
    s3Bucket: '/strands/test-infra/bedrock-knowledge-base/s3-source-bucket-name',
  })

  if (!resolved) {
    console.log('⏭️  Bedrock KB SSM parameters not available - KB integration tests will be skipped')
    return skip()
  }

  if (!resolved.knowledgeBaseId) {
    console.log('⏭️  Bedrock KB id not found in SSM - KB integration tests will be skipped')
    return skip()
  }

  console.log('⏭️  Bedrock KB parameters available - KB integration tests will run')
  return {
    shouldSkip: false,
    knowledgeBaseId: resolved.knowledgeBaseId,
    customDataSourceId: resolved.customDataSourceId,
    s3DataSourceId: resolved.s3DataSourceId,
    s3Bucket: resolved.s3Bucket,
  }
}

async function getGeminiTestContext(_isCI: boolean): Promise<ProvidedContext['provider-gemini']> {
  const apiKey = process.env.GEMINI_API_KEY
  const shouldSkip = !apiKey

  if (shouldSkip) {
    console.log('⏭️  Gemini API key not available - integration tests will be skipped')
    // Note: Gemini is not required in CI for now, so we don't throw an error
  } else {
    console.log('⏭️  Gemini API key available - integration tests will run')
  }

  return {
    apiKey: apiKey,
    shouldSkip: shouldSkip,
  }
}

async function getA2AServerContext(
  project: TestProject
): Promise<ProvidedContext['a2a-server'] & { abort?: () => void }> {
  const { testFiles } = await project.globTestFiles()
  const hasA2ATests = testFiles.some((f) => f.includes('/a2a/'))

  if (!hasA2ATests) {
    return { shouldSkip: true, url: undefined }
  }

  let credentials
  try {
    const credentialProvider = fromNodeProviderChain()
    credentials = await credentialProvider()
  } catch {
    console.log('⏭️  A2A server not available (no Bedrock credentials) - A2A integration tests will be skipped')
    return { shouldSkip: true, url: undefined }
  }

  const model = new BedrockModel({ clientConfig: { credentials } })
  const agent = new Agent({
    model,
    printer: false,
    systemPrompt: 'You are a helpful assistant. Always respond in a single short sentence.',
  })

  const a2aServer = new A2AExpressServer({
    agent,
    name: 'Test A2A Agent',
    description: 'Integration test agent',
  })

  // Use createMiddleware() with CORS headers so browser integ tests can reach the server.
  // Browser tests run on a different port (Vitest dev server), making this a cross-origin request.
  const app = express()
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', '*')
    res.setHeader('Access-Control-Allow-Headers', '*')
    next()
  })
  app.use(a2aServer.createMiddleware())

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      const url = `http://127.0.0.1:${addr.port}`
      // Update the agent card URL to reflect the actual bound port.
      // createMiddleware() doesn't do this automatically (unlike serve()).
      a2aServer.agentCard.url = url
      console.log(`⏭️  A2A server started on ${url}`)
      resolve({
        shouldSkip: false,
        url,
        abort: () => server.close(),
      })
    })
    server.on('error', reject)
  })
}
