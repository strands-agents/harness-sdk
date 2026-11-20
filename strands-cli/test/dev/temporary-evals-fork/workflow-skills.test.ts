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
      'run-evaluations',
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
      'run-evaluations',
      [
        'run my tests',
        'evaluate my agent',
        'check my agent against my examples',
        'did my last test pass',
        'rerun the failures',
      ],
    ],
    ['optimize-harness', ['can you make my agent better at this', 'improve this agent on refunds', 'tune its effort']],
  ])('shouldNameThePhrasesThatReach%s', (name, phrases) => {
    const description = descriptionFor(name as string)
    for (const phrase of phrases as string[]) expect(description).toContain(`"${phrase}"`)
    expect(description).toContain('in any wording')
  })

  it('shouldKeepEachSetOfTriggerPhrasesOutOfTheOtherSkills', () => {
    expect(descriptionFor('manage-experiments')).not.toContain('run my tests')
    expect(descriptionFor('run-evaluations')).not.toContain('what experiments do I have')
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
    expect(instructions).toContain('must not trigger generation, an evaluation, or optimization')
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

describe('run-evaluations guidance', () => {
  const instructions = instructionsFor('run-evaluations')

  it('shouldTestTheCurrentRuntimeAgentWithoutChangingSourceOrChoosingAGenerator', () => {
    expect(instructions).toContain('current authored agent through its SDK-configured runtime')
    expect(instructions).toContain('not a separate generator provider or the chat assistant')
    expect(instructions).toContain('An evaluation leaves the agent source unchanged')
    expect(instructions).toContain('scoring may also call models')
    expect(instructions).toContain('rather than asking the developer to configure a generator model')
  })

  it('shouldSupportSingleAndBatchRunsWithGuardedFailedOnlySelection', () => {
    expect(instructions).toContain('strands_dev_evaluate with {experiment, failedOnly?}')
    expect(instructions).toContain('{experiments: string[], failedOnly?}')
    expect(instructions).toContain('Use one selector, not both')
    expect(instructions).toContain('prior failures exist in a finished run for each selected experiment')
    expect(instructions).toContain('check strands_dev_evaluation_results first')
    expect(instructions).toContain('ask before substituting a paid full run')
    expect(instructions).toContain('Do not silently expand a failed-only request to all cases')
  })

  it('shouldReadExistingResultsWithoutRerunningOrClaimingTurnCancellationStopsTests', () => {
    expect(instructions).toContain('strands_dev_evaluation_results with {experiment, offset?, limit?}')
    expect(instructions).toContain('without rerunning anything')
    expect(instructions).toContain('page through case results as needed')
    expect(instructions).toContain('inspect results is not permission to rerun evaluations')
    expect(instructions).toContain('evaluation may continue after the developer cancels the chat turn')
    expect(instructions).toContain('Do not claim that cancelling a turn stopped the evaluation')
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

  it('shouldCarryTheEvalsOptimizeSkillAsTheWorkflow', () => {
    expect(instructions).toContain('The optimize skill of strands-evals follows. It is the workflow')
    expect(instructions).toContain('do not re-derive or contradict it')
    expect(instructions).toContain('# optimize')
    expect(instructions).toContain('strands-evals optimize run')
    expect(instructions).toContain('### 2. Knobs: what may change')
  })

  it('shouldSayWhereStrandsDevKeepsExperimentsAndRuns', () => {
    expect(instructions).toContain('strands-dev/experiments/<name>/<name>.json')
    expect(instructions).toContain('strands-dev/experiments/<name>/optimizations/<stamp>/')
    expect(instructions).toContain('call strands_dev_status for the saved experiments')
    expect(instructions).toContain('strands_dev_optimization_plan for the chosen one')
    expect(instructions).toContain('Never name a knob or a choice from memory')
  })

  it('shouldNotRunTheSkillsOwnScriptsOrCli', () => {
    expect(instructions).toContain('Do not ask for a workspace path')
    expect(instructions).toContain('do not run its scripts/prepare.mjs')
    expect(instructions).toContain('strands dev does that work through its own tools')
  })

  it('shouldPutEachQuestionOnScreenInsteadOfTheChatLists', () => {
    expect(instructions).toContain('strands dev has an on-screen question UI')
    expect(instructions).toContain('Put each question up with strands_dev_ask, one component per question')
    expect(instructions).toContain("Keep the skill's order, defaults and wording")
    expect(instructions).toContain('never add a decline option of your own')
  })

  it('shouldStartRunsThroughTheToolAndAllowThemInParallel', () => {
    expect(instructions).toContain('start the run with strands_dev_optimize once the review is confirmed')
    expect(instructions).toContain('a run already going is not a reason to refuse a new one')
  })

  it('shouldApplyOnlyNamedEditsAndPreserveAPendingReview', () => {
    expect(instructions).toContain('Apply only the ones the developer names, with strands_dev_apply_optimization')
    expect(instructions).toContain('never write them with file tools')
    expect(instructions).toContain('Preserve an unaccepted review')
    expect(instructions).toContain('strands_dev_reject_optimization only on explicit intent to discard')
    expect(instructions).toContain('strands_dev_cancel_optimization only when the developer asks to stop a run')
  })

  it('shouldCheckFinalAnswerEvaluatorCompatibilityWithoutSilentlyRewritingExperiments', () => {
    expect(instructions).toContain('optimization of a TypeScript agent scores the final answer only')
    expect(instructions).toContain('OutputEvaluator, Contains, Equals, and StartsWith')
    expect(instructions).toContain('A Python agent also scores trajectory and tool-use evaluators')
    expect(instructions).toContain('never silently remove an evaluator or rewrite the experiment')
    expect(instructions).toContain('Do not promise an improvement')
  })
})
