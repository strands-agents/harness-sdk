import { isRecord } from '../../values.js'

const CHECK_EVALUATORS: ReadonlySet<string> = new Set([
  'Equals',
  'Contains',
  'StartsWith',
  'ToolCalled',
  'SkillInvoked',
  'StructuredOutputSimilarity',
  'StateEquals',
])

export const temporaryJudgeEvaluatorCount = (evaluators: unknown): number =>
  (Array.isArray(evaluators) ? evaluators : [])
    .filter(isRecord)
    .filter(({ evaluator_type: type }) => typeof type !== 'string' || !CHECK_EVALUATORS.has(type)).length
