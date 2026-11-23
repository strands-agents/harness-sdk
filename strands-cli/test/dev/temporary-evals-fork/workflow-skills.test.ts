import { describe, expect, it } from 'vitest'

import {
  temporaryCommandWorkflows,
  temporaryWorkflowSkills,
} from '../../../src/dev/temporary-evals-fork/workflow-skills.js'

describe('background-evals skill', () => {
  it('shouldRunEveryStrandsEvalsCommandThroughTheBackgroundToolAndStayOutOfTheExportedAgent', () => {
    const [skill, ...others] = temporaryWorkflowSkills()

    expect(others).toEqual([])
    expect(skill!.name).toBe('background-evals')
    expect(skill!.description).toContain('Not part of the exported agent')
    expect(skill!.instructions).toContain('strands_dev_run_background')
    expect(skill!.instructions).toContain('run, optimize run, or generate')
    expect(skill!.instructions).toContain('there is no resume command')
    expect(skill!.instructions).toContain('strands_dev_stop_background only when the developer asks')
  })
})

describe('skill command workflows', () => {
  it.each(Object.entries(temporaryCommandWorkflows))('shouldKeepThe%sPromptShortAndDevSpecific', (_, workflow) => {
    expect(workflow).toContain('strands-dev/experiments/<name>/<name>.json')
    expect(workflow).toContain('strands_dev_open_evals_ui')
    expect(workflow).toContain('with the strands_dev_ UI tools, one question per call')
    expect(workflow).toContain('A cancelled question is a no.')
    expect(workflow).toContain('through the background-evals skill')
    expect(workflow).toContain('start it only when the developer approves in a later turn')
    expect(workflow.split('\n\n').length).toBeLessThanOrEqual(7)
  })

  it('shouldOfferTheSavedExperimentsAndCreateANewOneThenOpenThePickInTheEditorWhenExperimentRuns', () => {
    const { experiment } = temporaryCommandWorkflows

    expect(experiment).toContain('the strands-evals skill is active')
    expect(experiment).toContain('with exactly these rows: one per saved experiment')
    expect(experiment).toContain('then a last row "Create a new experiment" with the value new. Offer no other rows.')
    expect(experiment).toContain('call strands_dev_open_file')
    expect(experiment).toContain('do not print the file in chat')
    expect(experiment).toContain('ask the task straight away in chat')
    expect(experiment).toContain('Do not ask first how to build it.')
    expect(experiment).toContain('strands_dev_session_converter')
    expect(experiment).toContain('Do not ask about the number of cases, evaluators, the model')
    expect(experiment).toContain('Name the experiment after what it tests')
  })

  it('shouldPrintTheReviewInTheSkillsFormatAndWaitForTheReplyWhenOptimizeRuns', () => {
    const { optimize } = temporaryCommandWorkflows

    expect(optimize).toContain('the optimize skill is active')
    expect(optimize).toContain("Print the review in chat in the skill's own format and end the turn")
    expect(optimize).toContain('strands_dev_optimization_plan')
    expect(optimize).toContain('strands_dev_apply_optimization')
    expect(optimize).toContain('pass --tune KEY for each one picked, such as --tune tools')
    expect(optimize).toContain('applying its edit writes the option into the call')
    expect(optimize).toContain('Ask the budget in one strands_dev_number_input')
    expect(optimize).toContain('Any whole number from the min works')
  })
})

describe('/experiment runs and reports', () => {
  it('shouldHaveNoEvaluateWorkflowNowThatExperimentRunsThem', () => {
    expect(Object.keys(temporaryCommandWorkflows)).toEqual(['experiment', 'optimize'])
  })

  it('shouldOfferTheReportFirstOnceAnExperimentHasRunThenRunAndEdit', () => {
    const { experiment } = temporaryCommandWorkflows

    expect(experiment).toContain('"What do you want to do with <name>?"')
    expect(experiment).toContain('"View its last report" (value report) as the first row when its lastTest is done')
    expect(experiment).toContain('"Run it again" (value run) when its lastTest is done, otherwise "Run it"')
    expect(experiment).toContain('Leave it out while its lastTest is running')
    expect(experiment).toContain('"Edit its cases" (value edit)')
    expect(experiment).toContain('read it with strands_dev_evaluation_results')
    expect(experiment).toContain('strands_dev_open_evals_ui with the report view')
  })

  it('shouldStartAPickedRunWithoutAskingAgainInChat', () => {
    const { experiment } = temporaryCommandWorkflows

    expect(experiment).toContain('Picking Run is the approval')
    expect(experiment).toContain('without asking again in chat')
  })

  it('shouldStillRunSeveralExperimentsAtOnce', () => {
    const { experiment } = temporaryCommandWorkflows

    expect(experiment).toContain('"Run several experiments" with the value several when two or more are saved')
    expect(experiment).toContain('strands_dev_multi_select')
    expect(experiment).toContain('Picking them is the approval')
    expect(experiment).toContain('A cancelled question starts nothing.')
  })
})

describe('/optimize experiment pick', () => {
  it('shouldListEverySavedExperimentAsARowAndNameNoneInTheQuestion', () => {
    const { optimize } = temporaryCommandWorkflows

    expect(optimize).toContain('one row per saved experiment from strands_dev_status')
    expect(optimize).toContain('Do not name experiments in the question or list them in chat')
  })
})

describe('/optimize constraints question', () => {
  it('shouldLeaveTheMetricListOutOfTheConstraintsQuestion', () => {
    expect(temporaryCommandWorkflows.optimize).toContain('no parenthetical of metrics in the question or the rows')
  })
})

describe('/optimize after the run', () => {
  it('shouldLeaveTheEditsToTheDiffOnScreenAndAnswerWhatTheFetchedSkillAsks', () => {
    const { optimize } = temporaryCommandWorkflows

    expect(optimize).toContain("its edits appear on the developer's screen as a diff")
    expect(optimize).toContain('do not print the edit text or ask which edits to apply')
    expect(optimize).toContain('strands_dev_review_optimization puts it back on screen')
    expect(optimize).toContain('When strands_dev_optimization_plan returns autoOptimize')
    expect(optimize).toContain('best.diff or best.values.json')
    expect(optimize).toContain('Skip the skill\'s "Resuming a run" section')
    expect(optimize).toContain("Where the skill says a TypeScript agent's steps are traced, they are not here")
  })
})
