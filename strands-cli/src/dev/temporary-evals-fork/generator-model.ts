/** The evals CLI takes an SDK model string, not the chat's provider configuration. */
const BEDROCK_ID =
  /^(?:(?:us|eu|apac|global|jp|au|ca|us-gov)\.)?(?:anthropic|amazon|meta|mistral|cohere|ai21|deepseek|qwen|writer)\.[\w.:-]+$/u
const OPENAI_BEDROCK_ID = /^(?:(?:us|eu|apac|global|jp|au|ca|us-gov)\.)?openai\.[\w.:-]+$/u

export const generatorModelProblem = (model: string): string | undefined => {
  if (!model.trim()) return undefined
  const value = model.trim()
  const explicit = value.startsWith('bedrock/')
  const id = explicit ? value.slice('bedrock/'.length) : value
  const arn =
    /^arn:(?:aws|aws-us-gov|aws-cn):bedrock:[a-z0-9-]+:\d*:(?:foundation-model|inference-profile|application-inference-profile)\/[\w./:-]+$/u.test(
      id
    )
  if (arn || BEDROCK_ID.test(id) || (explicit && OPENAI_BEDROCK_ID.test(id))) return undefined
  return (
    'Experiment generation uses a separate AWS Bedrock connection, not the chat provider. ' +
    `Cannot use ${JSON.stringify(value)} as a generator model. Choose a Bedrock model ID, or leave model empty for the evals SDK default. ` +
    'For OpenAI models hosted on Bedrock, use bedrock/<Bedrock model ID> explicitly. This does not change the chat model.'
  )
}

export const generatorModelId = (model: string): string => {
  const problem = generatorModelProblem(model)
  if (problem) throw new Error(problem)
  return model.trim().replace(/^bedrock\//u, '')
}
