import { createElement } from 'react'
import { Box } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessPicker } from '../../src/dev/picker.js'
import * as terminal from '../../src/terminal/terminal.js'
import { StartupContentRows } from '../../src/ui/startup.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const harness = {
  name: 'Project harness',
  entrypoint: '/project/agent.py',
  root: '/project',
  language: 'python' as const,
}

afterEach(() => vi.restoreAllMocks())

describe('HarnessPicker', () => {
  it.each([120, 60])('shouldKeepRowsFixedWhenDescriptionsChangeAtWidth%s', async (columns) => {
    const input = ttyInput()
    const output = ttyOutput(columns, 40)
    const frame = captureFrame(output)
    render(
      createElement(
        Box,
        { height: 40, width: columns, flexDirection: 'column', justifyContent: 'flex-end' },
        createElement(HarnessPicker, {
          cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' },
          folderFor: () => '/work/base-cli',
          harnesses: [harness],
          onSelect: vi.fn(),
        })
      ),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Manual import'))
    const positions = (): number[] =>
      ['Select a harness', 'CLI DEFAULT', 'Project harness', 'NEW PROJECT', '↑↓ select'].map((text) =>
        frame().findIndex((line) => line.includes(text))
      )
    const initial = positions()
    expect(initial.every((row) => row >= 0)).toBe(true)
    input.write('\u001b[B')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Local project only'))
    expect(positions()).toEqual(initial)
    input.write('\u001b[B')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Start a separate project'))
    expect(positions()).toEqual(initial)
    input.write('\u001b[B')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Manual import'))
    expect(positions()).toEqual(initial)
  })

  it('shouldKeepEveryChoiceReachableWhenTheTerminalIsSmall', async () => {
    const input = ttyInput()
    const output = ttyOutput(60, 10)
    const frame = captureFrame(output)
    const selected = vi.fn()
    render(
      createElement(HarnessPicker, {
        cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' },
        harnesses: [harness],
        onSelect: selected,
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Base CLI'))
    input.write('\u001b[B')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Project harness'))
    expect(frame().join('\n')).toContain('/project/agent.py')
    input.write('\r')
    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'discovered', harness }))
  })

  it('shouldSelectTheBaseCliWhenTheFirstChoiceIsAccepted', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const selected = vi.fn()
    render(
      createElement(HarnessPicker, {
        cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' },
        harnesses: [harness],
        onSelect: selected,
      }),
      {
        stdin: input,
        stdout: output,
      }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))

    const text = frame().join('\n')
    expect(text.indexOf('Base CLI')).toBeLessThan(text.indexOf('Project harness'))
    expect(text).toContain('Source: /home/test/.strands/cli.toml')
    expect(text).toContain('Manual import applies these changes globally')
    expect(text).toContain('development changes stay in this local workspace')
    expect(text).toContain('CLI DEFAULT')
    expect(text).toContain('LOCAL PROJECTS (1)')
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'cli' }))
  })

  it('shouldOfferCreationWhenOnlyTheBaseCliExists', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const selected = vi.fn()
    render(
      createElement(HarnessPicker, {
        cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' },
        harnesses: [],
        onSelect: selected,
      }),
      {
        stdin: input,
        stdout: output,
      }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Create a new harness'))

    input.write('\u001b[B')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('› Create a new harness'))
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Language: typescript'))
    input.write('\t')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Language: python'))
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'create', name: 'new-harness', language: 'python' })
    )
  })

  it('shouldHideTheBaseCliAndWarnWhenNoCliOptionIsGiven', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const selected = vi.fn()
    render(
      createElement(HarnessPicker, {
        harnesses: [harness],
        warning: 'When you select an agent, strands dev deletes your current agent.',
        onSelect: selected,
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))

    const text = frame().join('\n')
    expect(text).toContain('When you select an agent, strands dev deletes your current agent.')
    expect(text).not.toContain('Base CLI')
    expect(text).not.toContain('CLI DEFAULT')
    expect(text).toContain('1 / 2')
    expect(text).toContain('Source: /project/agent.py')
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'discovered', harness }))
  })

  it('shouldKeepTheWarningVisibleWhileCreatingAHarness', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const selected = vi.fn()
    render(
      createElement(HarnessPicker, {
        harnesses: [],
        warning: 'When you select an agent, strands dev deletes your current agent.',
        onSelect: selected,
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('› Create a new harness'))
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Create a harness'))

    expect(frame().join('\n')).toContain('When you select an agent, strands dev deletes your current agent.')
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'create', name: 'new-harness', language: 'typescript' })
    )
  })

  const withFolder = (harnesses: (typeof harness)[] = [harness]) => {
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const selected = vi.fn()
    render(
      createElement(HarnessPicker, {
        cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' },
        harnesses,
        folderFor: () => '/work/strands-dev',
        onSelect: selected,
      }),
      { stdin: input, stdout: output }
    )
    return { input, text: () => frame().join('\n'), selected }
  }

  it('shouldAskForThePrefilledWorkspaceFolderBeforeOpeningAChoice', async () => {
    const { input, text, selected } = withFolder()
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Project harness'))
    input.write('\r')

    await vi.waitFor(() => expect(text()).toContain('Choose a workspace folder'))
    expect(text()).toMatch(/Workspace folder: \/work▌?\s*$/m)
    expect(text()).toContain('A strands-dev folder will be created in this path')
    expect(text()).toContain('Project harness')
    expect(selected).not.toHaveBeenCalled()
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'discovered', harness }, '/work/strands-dev'))
  })

  it('shouldSubmitTheEditedFolderWhenTheUserChangesIt', async () => {
    const { input, text, selected } = withFolder()
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toMatch(/Workspace folder: \/work▌?\s*$/m))

    input.write('/my-agents')
    await vi.waitFor(() => expect(text()).toContain('Workspace folder: /work/my-agents'))
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'cli' }, '/work/my-agents'))
  })

  it('shouldReturnToTheListWhenEscapeIsPressedInTheFolderStep', async () => {
    const { input, text, selected } = withFolder()
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Choose a workspace folder'))

    input.write('\u001b')
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    expect(selected).not.toHaveBeenCalled()
    input.write('\u001b')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith(undefined))
  })

  it.each([
    ['BaseCli', '', '/home/test/.strands/cli.toml'],
    ['FoundHarness', '\u001b[B', '/project/agent.py'],
  ])('shouldShowTheSelectedAgentAboveTheFolderStepWhen%sIsChosen', async (_, move, path) => {
    const { input, text } = withFolder()
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write(move)
    input.write('\r')

    await vi.waitFor(() => expect(text()).toContain('Choose a workspace folder'))
    const lines = text().split('\n')
    const row = (label: string): number => lines.findIndex((line) => line.includes(label))
    expect(row('Agent selected')).toBeGreaterThanOrEqual(0)
    expect(row(path)).toBe(row('Agent selected') + 1)
    expect(row('Choose a workspace folder')).toBeGreaterThan(row(path))
  })

  it('shouldLeaveOutTheSelectedAgentWhenANewHarnessNeedsAFolder', async () => {
    const { input, text } = withFolder([])
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Create a new harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Tab language · Enter continue'))
    input.write('\r')

    await vi.waitFor(() => expect(text()).toContain('New project · new-harness'))
    expect(text()).not.toContain('Agent selected')
  })

  it('shouldAskForTheFolderAfterTheNewHarnessForm', async () => {
    const { input, text, selected } = withFolder([])
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Create a new harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Tab language · Enter continue'))
    input.write('\r')

    await vi.waitFor(() => expect(text()).toContain('New project · new-harness'))
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith(
        { kind: 'create', name: 'new-harness', language: 'typescript' },
        '/work/strands-dev'
      )
    )
  })

  it('shouldRequireAFolderBeforeContinuing', async () => {
    const { input, text, selected } = withFolder()
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toMatch(/Workspace folder: \/work▌?\s*$/m))

    input.write('\u0015')
    await vi.waitFor(() => expect(text()).not.toContain('Workspace folder: /work'))
    input.write('\r')

    await vi.waitFor(() => expect(text()).toContain('Enter a workspace folder.'))
    expect(selected).not.toHaveBeenCalled()
  })

  it('shouldReturnToTheListWhenEscapeIsPressedAfterTheNewHarnessForm', async () => {
    const { input, text, selected } = withFolder([])
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Create a new harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Create a harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Choose a workspace folder'))

    input.write('\u001b')

    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    expect(selected).not.toHaveBeenCalled()
  })

  it('shouldKeepTheFolderStepOpenSoTheUserCanRetryAfterAFailure', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const selected = vi.fn().mockRejectedValueOnce(new Error('Folder is busy')).mockResolvedValueOnce(undefined)
    render(
      createElement(HarnessPicker, {
        cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' },
        harnesses: [],
        folderFor: () => '/work/strands-dev',
        onSelect: selected,
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Choose a workspace folder'))
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Folder is busy'))
    expect(frame().join('\n')).toContain('Choose a workspace folder')

    input.write('/other')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Workspace folder: /work/other'))
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenLastCalledWith({ kind: 'cli' }, '/work/other'))
    expect(selected).toHaveBeenNthCalledWith(1, { kind: 'cli' }, '/work/strands-dev')
    expect(selected).toHaveBeenCalledTimes(2)
  })

  it('shouldNameTheNumberedFolderInTheNoteUntilThePathChanges', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const selected = vi.fn()
    render(
      createElement(HarnessPicker, {
        cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' },
        harnesses: [],
        folderFor: () => '/work/strands-dev-2',
        onSelect: selected,
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toMatch(/Workspace folder: \/work▌?\s*$/m))
    expect(frame().join('\n')).toContain('A strands-dev-2 folder will be created in this path')

    input.write('/next')

    await vi.waitFor(() => expect(frame().join('\n')).toContain('A strands-dev folder will be created in this path'))
    expect(frame().join('\n')).not.toContain('strands-dev-2')
  })

  const withPlacement = () => {
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const selected = vi.fn()
    const other = { ...harness, name: 'Other harness', entrypoint: '/other/agent.py', root: '/other' }
    render(
      createElement(HarnessPicker, {
        cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' },
        harnesses: [harness, other],
        folderFor: (choice) =>
          choice.kind === 'cli'
            ? '/launch/strands-dev'
            : choice.kind === 'discovered'
              ? `${choice.harness.root}/strands-dev`
              : undefined,
        newProject: '/launch/strands-workspace',
        onSelect: selected,
      }),
      { stdin: input, stdout: output }
    )
    return { input, text: () => frame().join('\n'), selected, other }
  }

  it('shouldPrefillTheFolderNextToEachHarnessWhenTheUserSelectsIt', async () => {
    const { input, text, selected, other } = withPlacement()
    await vi.waitFor(() => expect(text()).toContain('Workspace: /launch/strands-dev'))
    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('Workspace: /project/strands-dev'))
    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('Workspace: /other/strands-dev'))
    input.write('\r')

    await vi.waitFor(() => expect(text()).toMatch(/Workspace folder: \/other▌?\s*$/m))
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'discovered', harness: other }, '/other/strands-dev')
    )
  })

  it('shouldCreateInTheLaunchFolderWithoutAFolderStepWhenTheNewHarnessHasNoFolder', async () => {
    const { input, text, selected } = withPlacement()
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    for (const _ of [1, 2, 3]) input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('Creates /launch/strands-workspace from your saved profile.'))
    input.write('\r')
    await vi.waitFor(() =>
      expect(text()).toContain('Creates /launch/strands-workspace with the agent and its strands-dev folder.')
    )
    expect(text()).toContain('Enter create')
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'create', name: 'new-harness', language: 'typescript' })
    )
    expect(text()).not.toContain('Choose a workspace folder')
  })

  const createForm = async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const selected = vi.fn()
    render(createElement(HarnessPicker, { harnesses: [], onSelect: selected }), { stdin: input, stdout: output })
    await vi.waitFor(() => expect(frame().join('\n')).toContain('› Create a new harness'))
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('› Name: new-harness'))
    return { input, text: () => frame().join('\n'), selected }
  }

  it('shouldMoveToTheLanguageFieldAndChangeItWhenArrowsArePressed', async () => {
    const { input, text, selected } = await createForm()

    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Language: typescript'))
    input.write('\u001b[C')
    await vi.waitFor(() => expect(text()).toContain('› Language: python'))
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'create', name: 'new-harness', language: 'python' })
    )
  })

  it('shouldEditTheNameOnlyWhenTheNameFieldIsSelected', async () => {
    const { input, text, selected } = await createForm()
    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Language: typescript'))

    input.write('x')
    input.write('\u001b[A')
    await vi.waitFor(() => expect(text()).toContain('› Name: new-harness'))
    input.write('y')
    await vi.waitFor(() => expect(text()).toContain('Name: new-harnessy'))
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'create', name: 'new-harnessy', language: 'typescript' })
    )
  })

  it('shouldCopyTheFullOpenFailureWhenControlYIsPressed', async () => {
    const copy = vi.spyOn(terminal, 'copyTerminalText').mockResolvedValue(true)
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const reason = `Reason: ${'missing dependency '.repeat(12)}`
    render(
      createElement(HarnessPicker, {
        cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' },
        harnesses: [harness],
        onSelect: vi.fn().mockRejectedValue(new Error(reason)),
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))
    expect(frame().join('\n')).not.toContain('Ctrl+Y copy error')

    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Ctrl+Y copy error'))
    input.write('\u0019')

    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
    const copied = copy.mock.calls[0]![0]
    expect(copied).toContain('Workspace could not open.')
    expect(copied).toContain(reason.trim())
    await vi.waitFor(() => expect(frame().join('\n')).toContain(`${copied.length} chars copied to clipboard`))
  })

  const renderWithRows = (rows: number, warning?: string): (() => string[]) => {
    const output = ttyOutput(120, 50)
    const frame = captureFrame(output)
    render(
      createElement(
        StartupContentRows,
        { value: rows },
        createElement(HarnessPicker, {
          cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' },
          harnesses: [harness, { ...harness, name: 'Other harness' }],
          ...(warning ? { warning } : {}),
          onSelect: vi.fn(),
        })
      ),
      { stdin: ttyInput(), stdout: output }
    )
    return frame
  }

  it.each([12, 16, 24])('shouldFitTheRowsTheStartupScreenGivesItWhenThereAre%sRows', async (rows) => {
    const frame = renderWithRows(rows, 'Selecting a new agent deletes your current agent in strands dev.')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Esc cancel'))

    expect(frame().length).toBeLessThanOrEqual(rows)
    expect(frame().join('\n')).toContain('Source: /home/test/.strands/cli.toml')
  })

  it.each([
    [14, false],
    [40, true],
  ])('shouldShowTheDetailNotesOnlyWhenEveryChoiceFitsAt%sRows', async (rows, notesVisible) => {
    const frame = renderWithRows(rows)
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Esc cancel'))

    expect(frame().join('\n').includes('Manual import applies')).toBe(notesVisible)
  })

  it.each([
    [11, false],
    [12, true],
  ])('shouldShowTheSelectedAgentOnlyWhenTheFolderStepFitsAt%sRows', async (rows, agentVisible) => {
    const input = ttyInput()
    const output = ttyOutput(120, 50)
    const frame = captureFrame(output)
    render(
      createElement(
        StartupContentRows,
        { value: rows },
        createElement(HarnessPicker, { harnesses: [harness], folderFor: () => '/work/strands-dev', onSelect: vi.fn() })
      ),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))
    input.write('\r')

    await vi.waitFor(() => expect(frame().join('\n')).toContain('Choose a workspace folder'))
    expect(frame().join('\n').includes('Agent selected')).toBe(agentVisible)
    expect(frame().length).toBeLessThanOrEqual(rows)
  })
})
