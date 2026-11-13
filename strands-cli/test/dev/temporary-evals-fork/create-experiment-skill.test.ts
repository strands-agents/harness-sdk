import { describe, expect, it } from 'vitest'

import {
  temporaryCreateExperimentPrompt,
  temporaryCreateExperimentSkill,
} from '../../../src/dev/temporary-evals-fork/create-experiment-skill.js'

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
  })
})
