import 'vitest'
import type { AwsCredentialIdentity } from '@aws-sdk/types'

declare module 'vitest' {
  export interface ProvidedContext {
    isCI: boolean
    isBrowser: boolean
    ['provider-openai']: {
      shouldSkip: boolean
      apiKey: string | undefined
    }
    ['provider-bedrock']: {
      shouldSkip: boolean
      credentials: AwsCredentialIdentity | undefined
    }
    ['provider-bedrock-kb']: {
      shouldSkip: boolean
      knowledgeBaseId: string | undefined
      customDataSourceId: string | undefined
      s3DataSourceId: string | undefined
      s3Bucket: string | undefined
    }
    ['provider-anthropic']: {
      shouldSkip: boolean
      apiKey: string | undefined
    }
    ['provider-gemini']: {
      shouldSkip: boolean
      apiKey: string | undefined
    }
    ['a2a-server']: {
      shouldSkip: boolean
      url: string | undefined
    }
    ['provider-ssh-ec2']: {
      shouldSkip: boolean
      host: string | undefined
      port: number | undefined
      identityFile: string | undefined
      workingDir: string | undefined
    }
  }
}
