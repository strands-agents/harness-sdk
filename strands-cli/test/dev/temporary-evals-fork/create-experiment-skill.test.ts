import { describe, expect, it } from 'vitest'

import {
  temporaryCreateExperimentPrompt,
  temporaryCreateExperimentSkill,
  temporaryRetryExperimentPrompt,
} from '../../../src/dev/temporary-evals-fork/create-experiment-skill.js'
import type { GenerationSettings } from '../../../src/dev/panels/model.js'

describe('dev-only experiment guidance', () => {
  it('shouldUseTheConversationInsteadOfASettingsInterview', () => {
    const { instructions } = temporaryCreateExperimentSkill()
    expect(instructions).toContain("Use the developer's request and earlier conversation first")
    expect(instructions).toContain('ask one brief, open question')
    expect(instructions).toContain('rather than asking again')
    expect(instructions).toContain('Keep technical settings in the background')
    expect(instructions).not.toContain('so always ask about it')
    expect(instructions).not.toContain('Show the settings as a short list')
    expect(temporaryCreateExperimentPrompt()).toBe('$create-experiment')
  })

  it('shouldRequireApprovalForGenerationWithoutTurningTheWorkflowIntoAgentInstructions', () => {
    const { instructions, description } = temporaryCreateExperimentSkill()
    expect(description).toContain('Not part of the exported agent')
    expect(instructions).toContain('Never add this skill')
    expect(instructions).toContain('source, saved instructions, configuration, or exports')
    expect(instructions).toContain('Never start a paid run based only on opening Create a new experiment')
    expect(instructions).toContain('without approval')
    expect(instructions).toContain('does not inherit the chat provider')
    expect(instructions).toContain('Never copy the chat model name')
  })
})

describe('TEMPORARY create-experiment flow', () => {
  const instructions = (): string => temporaryCreateExperimentSkill().instructions

  const settings = (overrides: Partial<GenerationSettings> = {}): GenerationSettings => ({
    name: 'refunds',
    task: 'Answer refund questions',
    context: 'Late deliveries',
    cases: 3,
    topics: 0,
    evaluators: [{ name: 'OutputEvaluator' }],
    model: '',
    parallel: 4,
    expectedOutput: true,
    expectedTrajectory: false,
    expectedInteractions: false,
    metadata: false,
    ...overrides,
  })

  it.each([
    ['one step at a time', 'Move forward one step at a time'],
    ['one question for each message', 'Do not stack several questions in one message'],
    ['what it took from the answer', 'say in one line what you took from it'],
  ])('shouldWalkForwardBy %s', (_rule, line) => {
    expect(instructions()).toContain(line)
  })

  it.each([
    ['the model calls of a generation', 'one time for each case'],
    ['how long a generation takes', 'one to several minutes'],
    ['the file that it writes', 'tmp/experiments/<name>.json'],
    ['that a save never replaces a file', 'A save never replaces a file'],
    ['that the run survives a cancelled turn', 'continues when the developer cancels the turn'],
    ['the wait on the first evaluator call', 'can take a minute'],
  ])('shouldNameTheActionBeforeItRunsIncluding %s', (_case, line) => {
    expect(instructions()).toContain(line)
  })

  it.each([
    ['several evaluators are allowed', 'An experiment can use several evaluators'],
    ['each evaluator scores every case', 'each one scores every case'],
    ['it says what each evaluator checks', 'say in plain words what each one checks'],
    ['a rubric judge differs from a check', 'calls no model'],
    ['an unavailable evaluator gets its reason', 'cannot score this agent'],
    ['optimize needs answer-only evaluators', '/optimize scores with the final answer only'],
  ])('shouldCoverScoringWhere %s', (_case, line) => {
    expect(instructions()).toContain(line)
  })

  it('shouldSendTheCauseAndEverySettingWhenTheUserAsksToFixAFailedGeneration', () => {
    const prompt = temporaryRetryExperimentPrompt(
      'refunds',
      settings({
        evaluators: [{ name: 'OutputEvaluator' }, { name: 'ToolCalled', settings: { tool_name: 'lookup_order' } }],
      }),
      { summary: 'Bedrock throttled the requests', detail: 'press r' }
    )

    expect(prompt).toContain('$create-experiment The experiment refunds stopped: Bedrock throttled')
    expect(prompt).toContain('evaluators OutputEvaluator and ToolCalled {"tool_name":"lookup_order"}')
    expect(prompt).toContain('Help me fix the settings, then generate it again.')
  })

  it('shouldSayThatTheGenerationFailedWhenTheFailureHasNoSummary', () => {
    expect(temporaryRetryExperimentPrompt('refunds', settings(), undefined)).toContain(
      'The experiment refunds stopped: the generation failed.'
    )
  })
})
