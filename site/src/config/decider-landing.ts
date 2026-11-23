import { siteLink } from '../util/links'

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
const DECIDER_ASK_COMMAND = `strands-decider ask ${DECIDER_DEFAULT_MODEL} \\
  --state "Help! My payouts have been failing for 3 days." \\
  --choice "team=billing,technical,sales"`

export const DECIDER_LINKS = {
  quickstart: '/docs/labs/strands-decider/quickstart/',
  introduction: '/docs/labs/strands-decider/introduction/',
  models: '/docs/labs/strands-decider/models/',
  sdk: '/docs/user-guide/sdk/decision-models/',
} as const

export const DECIDER_HERO_META = ['Python 3.11+', 'Choice', 'Yes / no', 'Score'] as const

export const DECIDER_OVERVIEW_DESCRIPTION =
  'Strands Decider is a System One model for repeated decisions. It scores a known output space (Choice, Yes / no, or Score) and returns a typed answer with calibrated confidence instead of generated text.'

export const DECIDER_DECISION_EXAMPLES = [
  {
    id: 'choice',
    state: 'Help! My payouts have been failing for 3 days.',
    question: 'Which team should handle this?',
    answerSpaceLabel: 'Available answers and criteria',
    criteria: [
      { label: 'billing', detail: 'billing and payments' },
      { label: 'technical', detail: 'bugs and outages' },
      { label: 'sales', detail: 'pre-sales questions' },
    ],
    responseLabel: 'Choice result',
    answerLabel: 'selected answer',
    answer: 'billing',
    probabilitiesLabel: 'Example answer probabilities',
    probabilities: [
      { id: 'billing', label: 'billing', value: 0.8505 },
      { id: 'technical', label: 'technical', value: 0.1469 },
      { id: 'sales', label: 'sales', value: 0.0026 },
    ],
    detailLabel: 'confidence',
    detailValue: '0.7757',
  },
  {
    id: 'noul',
    state: 'Help! My payouts have been failing for 3 days.',
    question: 'Is this request urgent?',
    answerSpaceLabel: 'Fixed yes / no space',
    criteria: [
      { label: 'no', detail: '0' },
      { label: 'yes', detail: '1' },
    ],
    responseLabel: 'Noul result',
    answerLabel: 'noul',
    answer: '0.94',
    probabilitiesLabel: 'Probability that the answer is yes',
    probabilities: [{ id: 'yes', label: 'yes', value: 0.94 }],
    detailLabel: 'at a 0.50 threshold',
    detailValue: 'yes',
  },
  {
    id: 'score',
    state: 'Order #4421 never arrived and the tracking link is broken.',
    question: 'How urgent is this?',
    answerSpaceLabel: 'Ordered scale',
    criteria: [
      { label: 'low', detail: '0' },
      { label: 'medium', detail: '1' },
      { label: 'high', detail: '2' },
      { label: 'critical', detail: '3' },
    ],
    responseLabel: 'Score result',
    answerLabel: 'expected level',
    answer: '1.71',
    probabilitiesLabel: 'Most likely level',
    probabilities: [{ id: 'high', label: 'high', value: 0.31 }],
    detailLabel: 'position',
    detailValue: 'between medium and high',
  },
] as const

const DECIDER_CLI_EXAMPLE = {
  answer: 'technical',
  confidence: 0.697,
  probabilities: [
    { label: 'technical', value: 0.798 },
    { label: 'billing', value: 0.195 },
    { label: 'sales', value: 0.007 },
  ],
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

export function buildDeciderLandingMarkdown(headingLevel = 1): string {
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
    'The quickstart command returns:',
    '',
    `- Selected answer: \`${DECIDER_CLI_EXAMPLE.answer}\``,
    `- Confidence: \`${DECIDER_CLI_EXAMPLE.confidence}\``,
    ...DECIDER_CLI_EXAMPLE.probabilities.map((item) => `- \`${item.label}\`: ${probability(item.value)}`),
    '',
    'Model outputs vary with the model and request. Validate accuracy and thresholds on your own traffic.',
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
  ]

  return lines.join('\n')
}
