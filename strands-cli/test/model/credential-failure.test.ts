import { describe, expect, it } from 'vitest'

import { isExpiredModelCredential, isModelCredentialFailure } from '../../src/model/credential-failure.js'

describe('model credential failures', () => {
  it.each([
    'The security token included in the request is expired',
    'An error occurred (ExpiredTokenException) when calling the ConverseStream operation: The security token included in the request is expired',
    'The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.',
    'Error when retrieving token from sso: Token has expired and refresh failed',
  ])('shouldReportExpiredCredentialsWhenTheProviderSays %s', (message) => {
    expect(isModelCredentialFailure(message)).toBe(true)
    expect(isExpiredModelCredential(message)).toBe(true)
  })

  it.each([
    'Could not load credentials from any providers',
    'The security token included in the request is invalid.',
    'Could not resolve authentication method. Expected either apiKey or authToken to be set.',
    'The OPENAI_API_KEY environment variable is missing or empty',
  ])('shouldReportMissingCredentialsAsNotExpiredWhenTheProviderSays %s', (message) => {
    expect(isModelCredentialFailure(message)).toBe(true)
    expect(isExpiredModelCredential(message)).toBe(false)
  })

  it.each(['Signature expired: 20261117T000000Z is now earlier than 20261117T000500Z', 'socket hang up'])(
    'shouldReportNoCredentialFailureWhenTheProviderSays %s',
    (message) => {
      expect(isModelCredentialFailure(message)).toBe(false)
      expect(isExpiredModelCredential(message)).toBe(false)
    }
  )
})
