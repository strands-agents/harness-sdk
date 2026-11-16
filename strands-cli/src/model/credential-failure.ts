const MODEL_CREDENTIAL_FAILURE =
  /credentials?|expiredtoken|security token|sso.*expired|authentication method|incorrect api key|api key not valid|api key is required|api_key environment variable is missing/i

export const isModelCredentialFailure = (message: string): boolean => MODEL_CREDENTIAL_FAILURE.test(message)
