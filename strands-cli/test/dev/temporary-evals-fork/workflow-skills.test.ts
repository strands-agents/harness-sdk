import { describe, expect, it } from 'vitest'

import { temporaryWorkflowSkills } from '../../../src/dev/temporary-evals-fork/workflow-skills.js'

const instructionsFor = (name: string): string => {
  const skill = temporaryWorkflowSkills().find((entry) => entry.name === name)
  expect(skill).toBeDefined()
  return skill!.instructions
}

describe('dev-only workflow skills', () => {
  it('shouldProvideThreeWorkflowSkillsWithoutReplacingCreateExperiment', () => {
    expect(temporaryWorkflowSkills().map(({ name }) => name)).toEqual([
      'manage-experiments',
      'run-tests',
      'optimize-harness',
    ])
    expect(instructionsFor('manage-experiments')).toContain('use the existing create-experiment skill')
  })

  it.each(temporaryWorkflowSkills())('shouldKeep$nameRuntimeOnlyAndOutOfTheAuthoredAgent', (skill) => {
    expect(skill.description).toContain('Not part of the exported agent')
    expect(skill.instructions).toContain('runtime-only developer-assistance workflow')
    expect(skill.instructions).toContain('Never copy this skill')
    expect(skill.instructions).toContain('source, saved instructions, configuration, or exports')
  })

  it.each(temporaryWorkflowSkills())('shouldGuide$nameNaturallyWithoutAQuestionnaire', ({ instructions }) => {
    expect(instructions).toContain("Use the developer's request and earlier conversation first")
    expect(instructions).toContain('do not require slash commands')
    expect(instructions).toContain('not a questionnaire')
    expect(instructions).toContain('Ask one brief question only when')
    expect(instructions).toContain('Read-only listing, inspection, and result retrieval do not need approval')
  })

  it.each(temporaryWorkflowSkills())(
    'shouldScopePaidRunApprovalFor$nameWithoutRepeatedConfirmation',
    ({ instructions }) => {
      expect(instructions).toContain('Before a paid run, briefly explain the concrete scope')
      expect(instructions).toContain('model calls cost money')
      expect(instructions).toContain('obtain approval before starting')
      expect(instructions).toContain('needs no repeated approval')
      expect(instructions).toContain('not permission for additional runs or a larger scope')
      expect(instructions).toContain('Do not invent a price or model-call count')
    }
  )

  it.each(temporaryWorkflowSkills())('shouldTreatARequestAsAskingForTheScopeNotTheRunIn$name', ({ instructions }) => {
    expect(instructions).toContain('Being asked to run, test, or improve something is not that approval')
    expect(instructions).toContain('end that turn with the scope and wait for a separate answer')
  })

  it.each(temporaryWorkflowSkills())(
    'shouldReadCurrentStateRatherThanRepeatAnEarlierAnswerIn$name',
    ({ instructions }) => {
      expect(instructions).toContain('call strands_dev_status again in every turn that asks what exists')
      expect(instructions).toContain('including a repeated question')
      expect(instructions).toContain('Reusing an earlier answer states a workspace that may no longer exist')
      expect(instructions).toContain('saying you just checked when you did not is a false claim')
    }
  )

  it.each(temporaryWorkflowSkills())('shouldAnswerOnlyWhatWasAskedIn$name', ({ instructions }) => {
    expect(instructions).toContain('Answer the question that was asked and stop')
    expect(instructions).toContain('rather than stacking questions or offering a numbered menu')
  })
})

describe('workflow skill activation triggers', () => {
  const descriptionFor = (name: string): string =>
    temporaryWorkflowSkills().find((entry) => entry.name === name)!.description

  it.each([
    ['manage-experiments', ['what experiments do I have', 'show me my cases', 'how is this scored']],
    [
      'run-tests',
      ['run my tests', 'check my agent against my examples', 'did my last test pass', 'rerun the failures'],
    ],
    ['optimize-harness', ['can you make my agent better at this', 'improve this agent on refunds', 'tune its effort']],
  ])('shouldNameThePhrasesThatReach%s', (name, phrases) => {
    const description = descriptionFor(name as string)
    for (const phrase of phrases as string[]) expect(description).toContain(`"${phrase}"`)
    expect(description).toContain('in any wording')
  })

  it('shouldKeepEachSetOfTriggerPhrasesOutOfTheOtherSkills', () => {
    expect(descriptionFor('manage-experiments')).not.toContain('run my tests')
    expect(descriptionFor('run-tests')).not.toContain('what experiments do I have')
    expect(descriptionFor('optimize-harness')).not.toContain('did my last test pass')
  })
})

describe('manage-experiments guidance', () => {
  const instructions = instructionsFor('manage-experiments')

  it('shouldInspectSavedCasesAndEvaluatorDetailsWithoutTriggeringPaidWork', () => {
    expect(instructions).toContain('Always call strands_dev_status afresh')
    expect(instructions).toContain('strands_dev_read_experiment with {experiment, offset?, limit?}')
    expect(instructions).toContain('read saved cases and evaluator details')
    expect(instructions).toContain('partial page is the whole experiment')
    expect(instructions).toContain('strands_dev_evaluators')
    expect(instructions).toContain('must not trigger generation, a test, or optimization')
  })

  it('shouldAllowOnlyRequestedFileEditsAndNeverInventManagementTools', () => {
    expect(instructions).toContain('no dedicated experiment-edit or delete tool')
    expect(instructions).toContain('existing file tools only when the developer requests edits')
    expect(instructions).toContain('first reading the file')
    expect(instructions).toContain('keeping unrelated cases and evaluators intact')
    expect(instructions).toContain('Do not automatically delete experiments')
    expect(instructions).toContain('strands_dev_create_experiment')
    expect(instructions).toContain('generation approval workflow')
  })
})

describe('run-tests guidance', () => {
  const instructions = instructionsFor('run-tests')

  it('shouldTestTheCurrentRuntimeAgentWithoutChangingSourceOrChoosingAGenerator', () => {
    expect(instructions).toContain('current authored agent through its SDK-configured runtime')
    expect(instructions).toContain('not a separate generator provider or the chat assistant')
    expect(instructions).toContain('Testing leaves the agent source unchanged')
    expect(instructions).toContain('scoring may also call models')
    expect(instructions).toContain('rather than asking the developer to configure a generator model')
  })

  it('shouldSupportSingleAndBatchRunsWithGuardedFailedOnlySelection', () => {
    expect(instructions).toContain('strands_dev_test with {experiment, failedOnly?}')
    expect(instructions).toContain('{experiments: string[], failedOnly?}')
    expect(instructions).toContain('Use one selector, not both')
    expect(instructions).toContain('prior failures exist in a finished run for each selected experiment')
    expect(instructions).toContain('check strands_dev_test_results first')
    expect(instructions).toContain('ask before substituting a paid full run')
    expect(instructions).toContain('Do not silently expand a failed-only request to all cases')
  })

  it('shouldReadExistingResultsWithoutRerunningOrClaimingTurnCancellationStopsTests', () => {
    expect(instructions).toContain('strands_dev_test_results with {experiment, offset?, limit?}')
    expect(instructions).toContain('without rerunning anything')
    expect(instructions).toContain('page through case results as needed')
    expect(instructions).toContain('inspect results is not permission to rerun tests')
    expect(instructions).toContain('test may continue after the developer cancels the chat turn')
    expect(instructions).toContain('Do not claim that cancelling a turn stopped the test')
    expect(instructions).not.toContain('strands_dev_cancel_test')
  })

  it('shouldReportOnlyObservedEvidenceAndDistinguishIncompleteOrFailedRuns', () => {
    expect(instructions).toContain('Report actual evidence from the tools')
    expect(instructions).toContain('Distinguish queued, running, failed execution, and completed results')
    expect(instructions).toContain('Do not fabricate results')
    expect(instructions).toContain('partial page as the complete run')
    expect(instructions).toContain('actual answers, and feedback only when returned')
    expect(instructions).toContain('not permission to change source, regenerate cases, optimize')
  })
})

describe('optimize-harness guidance', () => {
  const instructions = instructionsFor('optimize-harness')

  it('shouldCheckFinalAnswerEvaluatorCompatibilityWithoutSilentlyRewritingExperiments', () => {
    expect(instructions).toContain('strands_dev_read_experiment')
    expect(instructions).toContain('scores the final answer only')
    expect(instructions).toContain('OutputEvaluator, Contains, Equals, and StartsWith')
    expect(instructions).toContain('does not optimize trajectory or tool-use evaluator scores')
    expect(instructions).toContain('do not silently remove evaluators or rewrite the experiment')
    expect(instructions).toContain('do not require or start a separate paid baseline test')
  })

  it('shouldLimitTuningToSupportedKnobsAndExplainCostsWithoutPromisingImprovement', () => {
    expect(instructions).toContain(
      "strands_dev_optimize with {experiment, tune?: ('instructions' | 'effort')[], iterations?}"
    )
    expect(instructions).toContain('not arbitrary tools, models, or configuration')
    expect(instructions).toContain('default tune of instructions and default iteration count')
    expect(instructions).toContain('iteration budget, repeated model calls and scoring costs')
    expect(instructions).toContain('Do not promise an improvement')
  })

  it('shouldPreservePendingReviewsAndOnlyStopOrDiscardOnExplicitIntent', () => {
    expect(instructions).toContain('Preserve an unaccepted optimization review')
    expect(instructions).toContain('Before starting a new optimization that would overwrite it, ask')
    expect(instructions).toContain('strands_dev_reject_optimization with {} on explicit intent')
    expect(instructions).toContain('If an optimization is running, inspect its status rather than launching another')
    expect(instructions).toContain('strands_dev_cancel_optimization with {} only when the developer explicitly asks')
    expect(instructions).toContain('Cancelling the chat turn may leave the optimization running')
  })

  it('shouldRequireExplicitAcceptanceOfExactEditIndicesBeforeApplying', () => {
    expect(instructions).toContain('returns proposed edits; it does not apply them or change the agent source')
    expect(instructions).toContain(
      'strands_dev_apply_optimization with {edits: number[]} only after explicit acceptance'
    )
    expect(instructions).toContain('exact returned edit indices for the accepted subset')
    expect(instructions).toContain('Approval to optimize is not approval to apply')
    expect(instructions).toContain('Do not use file tools to bypass the review')
    expect(instructions).toContain('If no edits are accepted, leave the source unchanged')
    expect(instructions).toContain('Report application success or errors as returned')
    expect(instructions).toContain('follow-up paid validation run needs its own scoped approval')
  })

  it('shouldReportMeasuredScoresAndLimitationsRatherThanFabricateImprovements', () => {
    expect(instructions).toContain('actual baseline and candidate scores')
    expect(instructions).toContain('without fabricating measurements')
    expect(instructions).toContain('claiming general improvement from one experiment')
    expect(instructions).toContain('Keep failed execution distinct from a candidate that scored worse')
  })
})
