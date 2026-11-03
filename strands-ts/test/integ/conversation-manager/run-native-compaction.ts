/**
 * Runs the live native-compaction task once and prints a count-only report.
 *
 * Usage (from strands-ts/, after `npm run build`; makes paid first-party Anthropic requests):
 *   ANTHROPIC_API_KEY=... npx tsx test/integ/conversation-manager/run-native-compaction.ts [native|base]
 *
 * STRANDS_INTEG_MAIN_MODEL_ID and STRANDS_INTEG_SUMMARIZER_MODEL_ID override the models (default Sonnet 5.5 and
 * Haiku 5.5; set both to the same id for same-model compaction).
 */

import {
  HAIKU_5_5,
  SONNET_5_5,
  STRICT_THINKING,
  describeReport,
  runCompactionTask,
} from './native-compaction-harness.js'

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
const native = (process.argv[2] ?? 'native') === 'native'

const report = await runCompactionTask({
  apiKey,
  mainModelId: process.env.STRANDS_INTEG_MAIN_MODEL_ID ?? SONNET_5_5,
  summarizerModelId: process.env.STRANDS_INTEG_SUMMARIZER_MODEL_ID ?? HAIKU_5_5,
  serverSideCompaction: native ? true : undefined,
  thinking: native ? STRICT_THINKING : { type: 'adaptive' },
  passBeforeCalls: [4, 7],
})
console.log(describeReport(report))
