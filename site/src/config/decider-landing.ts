import { siteLink } from '../util/links'
import { buildProductContentMarkdown, type ProductContentItem } from './product-content'

export const DECIDER_HERO_TITLE = 'A model built to decide.'
export const DECIDER_HERO_DESCRIPTION = 'Route, classify, and score known outcomes without generating text.'
export const DECIDER_LANDING_TITLE = 'Strands Decider | A model built to decide'
export const DECIDER_LANDING_DESCRIPTION =
  'Strands Decider routes, classifies, and scores known outcomes with a decision model that returns typed answers and probability signals without generating text.'

export const DECIDER_REPOSITORY_URL = 'https://github.com/strands-labs/strands-decider'
export const DECIDER_DEFAULT_MODEL = 'StrandsAgents/strands-decider-E2B-gemma4-v2-2611'
export const DECIDER_INSTALL_COMMAND = 'pip install strands-decider'
const DECIDER_HUGGING_FACE_URL = 'https://huggingface.co/StrandsAgents'
const DECIDER_MATURITY_NOTE = 'Strands Labs · Experimental'

export const DECIDER_LINKS = {
  quickstart: '/docs/labs/strands-decider/quickstart/',
  introduction: '/docs/labs/strands-decider/introduction/',
  models: '/docs/labs/strands-decider/models/',
  sdk: '/docs/user-guide/sdk/decision-models/',
} as const

export const DECIDER_HERO_META = ['Python 3.11+', 'Choice', 'Yes / no', 'Score'] as const

export const DECIDER_OVERVIEW_DESCRIPTION =
  'Strands Decider is a System One model for repeated decisions. It scores a known output space (Choice, Yes / no, or Score) and returns a typed answer with calibrated confidence instead of generated text. These examples use recorded E2B output; results can vary slightly by device.'

export const DECIDER_RECORDED_EXAMPLE = {
  state: 'Help! My payouts have been failing for 3 days!',
  choice: {
    question: 'Which team should handle this?',
    criteria: [
      { label: 'billing', detail: '' },
      { label: 'sales', detail: '' },
      { label: 'retail', detail: '' },
    ],
    answer: 'billing',
    confidence: 0.659,
    probabilities: [
      { id: 'billing', label: 'billing', value: 0.773 },
      { id: 'sales', label: 'sales', value: 0.121 },
      { id: 'retail', label: 'retail', value: 0.106 },
    ],
  },
  noul: {
    question: 'Does this convey urgency?',
    answer: 0.858,
  },
  score: {
    question: 'How frustrated is the writer?',
    criteria: [
      { label: 'calm', detail: '0' },
      { label: 'frustrated', detail: '1' },
      { label: 'depressed', detail: '2' },
    ],
    answer: 1.03,
    confidence: 0.509,
    probabilities: [
      { id: 'calm', label: 'calm', value: 0.196 },
      { id: 'frustrated', label: 'frustrated', value: 0.574 },
      { id: 'depressed', label: 'depressed', value: 0.23 },
    ],
  },
} as const

const DECIDER_ASK_COMMAND = `strands-decider ask ${DECIDER_DEFAULT_MODEL} \\
  --state "${DECIDER_RECORDED_EXAMPLE.state}" \\
  --choice "${DECIDER_RECORDED_EXAMPLE.choice.question}=${DECIDER_RECORDED_EXAMPLE.choice.criteria.map(({ label }) => label).join(',')}" \\
  --noul "${DECIDER_RECORDED_EXAMPLE.noul.question}" \\
  --score "${DECIDER_RECORDED_EXAMPLE.score.question}=${DECIDER_RECORDED_EXAMPLE.score.criteria.map(({ label }) => label).join(',')}"`

export const DECIDER_DECISION_EXAMPLES = [
  {
    id: 'choice',
    state: DECIDER_RECORDED_EXAMPLE.state,
    question: DECIDER_RECORDED_EXAMPLE.choice.question,
    answerSpaceLabel: 'Available answers',
    criteria: DECIDER_RECORDED_EXAMPLE.choice.criteria,
    responseLabel: 'Choice result',
    answerLabel: 'selected answer',
    answer: DECIDER_RECORDED_EXAMPLE.choice.answer,
    probabilitiesLabel: 'Recorded answer probabilities',
    probabilities: DECIDER_RECORDED_EXAMPLE.choice.probabilities,
    detailLabel: 'confidence',
    detailValue: DECIDER_RECORDED_EXAMPLE.choice.confidence.toFixed(3),
  },
  {
    id: 'noul',
    state: DECIDER_RECORDED_EXAMPLE.state,
    question: DECIDER_RECORDED_EXAMPLE.noul.question,
    answerSpaceLabel: 'Fixed yes / no space',
    criteria: [
      { label: 'no', detail: '0' },
      { label: 'yes', detail: '1' },
    ],
    responseLabel: 'Noul result',
    answerLabel: 'noul',
    answer: DECIDER_RECORDED_EXAMPLE.noul.answer.toFixed(3),
    probabilitiesLabel: 'Probability that the answer is yes',
    probabilities: [{ id: 'yes', label: 'yes', value: DECIDER_RECORDED_EXAMPLE.noul.answer }],
    detailLabel: 'at a 0.50 threshold',
    detailValue: 'yes',
  },
  {
    id: 'score',
    state: DECIDER_RECORDED_EXAMPLE.state,
    question: DECIDER_RECORDED_EXAMPLE.score.question,
    answerSpaceLabel: 'Ordered scale',
    criteria: DECIDER_RECORDED_EXAMPLE.score.criteria,
    responseLabel: 'Score result',
    answerLabel: 'expected score',
    answer: DECIDER_RECORDED_EXAMPLE.score.answer.toFixed(2),
    probabilitiesLabel: 'Recorded level probabilities',
    probabilities: DECIDER_RECORDED_EXAMPLE.score.probabilities,
    detailLabel: 'confidence',
    detailValue: DECIDER_RECORDED_EXAMPLE.score.confidence.toFixed(3),
  },
] as const

const DECIDER_CLI_EXAMPLE = {
  choice: DECIDER_RECORDED_EXAMPLE.choice,
  noul: DECIDER_RECORDED_EXAMPLE.noul,
  score: DECIDER_RECORDED_EXAMPLE.score,
} as const

export const DECIDER_QUESTION_TYPES = [
  {
    id: 'choice',
    label: 'Choice',
    apiName: 'choice',
    title: 'Choose one known path',
    description: 'Returns one option, a probability for each option, and confidence.',
  },
  {
    id: 'noul',
    label: 'Yes / no',
    apiName: 'noul',
    title: 'Set an action threshold',
    description: 'Returns the probability that the answer is yes. Your application sets the threshold.',
  },
  {
    id: 'score',
    label: 'Score',
    apiName: 'score',
    title: 'Place an item on a scale',
    description: 'Returns an expected level, the distribution over levels, and confidence.',
  },
] as const

const DECIDER_FIT_SUMMARY =
  'Use Decider for repeated routing, classification, gating, or scoring when the possible answers are known before the request.'
const DECIDER_GENERATIVE_SUMMARY =
  'Keep a generative model when the result needs prose, code, a summary, an explanation, or multi-step reasoning.'

function heading(level: number, text: string): string {
  return `${'#'.repeat(Math.min(level, 6))} ${text}`
}

function landingLink(href: string): string {
  return href.startsWith('http') ? href : siteLink(href)
}

function probability(value: number): string {
  return value.toFixed(3)
}

export function buildDeciderLandingMarkdown(
  headingLevel = 1,
  productContent: readonly ProductContentItem[] = []
): string {
  const root = Math.min(Math.max(Math.trunc(headingLevel), 1), 3)
  const lines = [
    heading(root, 'Strands Decider'),
    '',
    '`/decider`',
    '',
    `_${DECIDER_MATURITY_NOTE}_`,
    '',
    DECIDER_OVERVIEW_DESCRIPTION,
    '',
    `- [Run your first decision](${landingLink(DECIDER_LINKS.quickstart)})`,
    `- [Compare models](${landingLink(DECIDER_LINKS.models)})`,
    `- [View Decider on GitHub](${DECIDER_REPOSITORY_URL})`,
    '',
    heading(root + 1, 'Install and ask'),
    '',
    'Decider requires Python 3.11 or later.',
    '',
    '```sh',
    DECIDER_INSTALL_COMMAND,
    DECIDER_ASK_COMMAND,
    '```',
    '',
    'The recorded combined example returns:',
    '',
    `- Choice: \`${DECIDER_CLI_EXAMPLE.choice.answer}\` (confidence \`${probability(DECIDER_CLI_EXAMPLE.choice.confidence)}\`)`,
    ...DECIDER_CLI_EXAMPLE.choice.probabilities.map((item) => `  - \`${item.label}\`: ${probability(item.value)}`),
    `- Noul: \`${probability(DECIDER_CLI_EXAMPLE.noul.answer)}\``,
    `- Score: \`${DECIDER_CLI_EXAMPLE.score.answer.toFixed(2)}\` (confidence \`${probability(DECIDER_CLI_EXAMPLE.score.confidence)}\`)`,
    ...DECIDER_CLI_EXAMPLE.score.probabilities.map(
      (item, index) => `  - \`${index}: ${item.label}\`: ${probability(item.value)}`
    ),
    '',
    'These recorded outputs are illustrative. Results can vary slightly by device, and you should validate accuracy and thresholds on your own traffic.',
    '',
    heading(root + 1, 'Answer shapes'),
    '',
    ...DECIDER_QUESTION_TYPES.map((type) => `- **${type.label}** (\`${type.apiName}\`): ${type.description}`),
    '',
    heading(root + 1, 'When Decider fits'),
    '',
    DECIDER_FIT_SUMMARY,
    '',
    DECIDER_GENERATIVE_SUMMARY,
    '',
    `- [Understand the boundary](${landingLink(DECIDER_LINKS.introduction)})`,
    `- [Use bounded decisions with the Strands SDK](${landingLink(DECIDER_LINKS.sdk)})`,
    `- [Browse model weights](${DECIDER_HUGGING_FACE_URL})`,
    '',
    ...buildProductContentMarkdown(productContent, root + 1),
  ]

  return lines.join('\n')
}
