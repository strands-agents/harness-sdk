import chalk from 'chalk'
import { createElement } from 'react'
import { Box } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseHarness, HarnessPicker } from '../../src/dev/picker.js'
import type { DiscoveredHarness } from '../../src/dev/search.js'
import * as terminal from '../../src/terminal/terminal.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'
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
          folderFor: () => ({ path: '/work/base-cli', detected: false }),
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
    expect(text).toContain('DISCOVERED PROJECTS (1)')
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
        folderFor: () => ({ path: '/work/strands-dev', detected: false }),
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

    await vi.waitFor(() => expect(text()).toContain('Create a workspace'))
    expect(text()).toMatch(/Workspace folder: \/work▌?\s*$/m)
    expect(text()).toContain('A strands-dev folder will be created in this path')
    expect(text()).toContain('Project harness')
    expect(selected).not.toHaveBeenCalled()
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'discovered', harness }, '/work/strands-dev'))
  })

  const withDetectedWorkspace = () => {
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const selected = vi.fn()
    render(
      createElement(HarnessPicker, {
        cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' },
        harnesses: [],
        folderFor: () => ({ path: '/home/test/.strands/strands-dev', detected: true }),
        onSelect: selected,
      }),
      { stdin: input, stdout: output }
    )
    return { input, text: () => frame().join('\n'), selected }
  }

  it('shouldOfferTheDetectedWorkspaceWhenTheChoiceAlreadyHasOne', async () => {
    const { input, text, selected } = withDetectedWorkspace()
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\r')

    await vi.waitFor(() => expect(text()).toContain('Select a workspace'))
    expect(text()).toMatch(/Detected workspace: \/home\/test\/\.strands\/strands-dev▌?\s*$/m)
    expect(text()).not.toContain('Create a workspace')
    expect(text()).not.toContain('will be created')
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'cli' }, '/home/test/.strands/strands-dev'))
  })

  it.each([
    ['-next', 'A strands-dev folder will be created in this path'],
    ['-2', 'A strands-dev-2 folder will be created at this path'],
  ])('shouldAskToCreateAWorkspaceWhenTheUserAppends%sToTheDetectedPath', async (typed, note) => {
    const { input, text, selected } = withDetectedWorkspace()
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Select a workspace'))

    input.write(typed)

    await vi.waitFor(() => expect(text()).toContain('Create a workspace'))
    expect(text()).toContain(`Workspace folder: /home/test/.strands/strands-dev${typed}`)
    expect(text()).toContain(note)
    input.write('\r')
    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'cli' }, `/home/test/.strands/strands-dev${typed}`)
    )
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
    await vi.waitFor(() => expect(text()).toContain('Create a workspace'))

    input.write('\u001b')
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    expect(selected).not.toHaveBeenCalled()
    input.write('\u001b')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith(undefined))
  })

  it.each([
    ['BaseCli', '', '/home/test/.strands/cli.toml'],
    ['FoundHarness', '\u001b[B', '/project/agent.py'],
  ])('shouldShowTheSelectedProjectAboveTheFolderStepWhen%sIsChosen', async (_, move, path) => {
    const { input, text } = withFolder()
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write(move)
    input.write('\r')

    await vi.waitFor(() => expect(text()).toContain('Create a workspace'))
    const lines = text().split('\n')
    const row = (label: string): number => lines.findIndex((line) => line.includes(label))
    expect(row('Selected project')).toBeGreaterThanOrEqual(0)
    expect(row(`Harness path: ${path}`)).toBe(row('Selected project') + 1)
    expect(row('Create a workspace')).toBeGreaterThan(row(`Harness path: ${path}`))
  })

  it('shouldLeaveOutTheSelectedProjectWhenANewHarnessNeedsAFolder', async () => {
    const { input, text } = withFolder([])
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Create a new harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Tab language · Enter continue'))
    input.write('\r')

    await vi.waitFor(() => expect(text()).toContain('New project · new-harness'))
    expect(text()).not.toContain('Selected project')
  })

  it('shouldColorTheHeadingAndContextGreenWhenTheFolderStepIsShown', async () => {
    const level = chalk.level
    chalk.level = 3
    try {
      const input = ttyInput()
      const output = ttyOutput(100, 36)
      const frame = captureFrame(output)
      let headingRow = ''
      output.on('data', (chunk: Buffer) => {
        headingRow =
          chunk
            .toString()
            .split('\n')
            .find((line) => sanitizeTerminalText(line).includes('Create a workspace')) ?? headingRow
      })
      render(
        createElement(HarnessPicker, {
          harnesses: [harness],
          folderFor: () => ({ path: '/work/strands-dev', detected: false }),
          onSelect: vi.fn(),
        }),
        { stdin: input, stdout: output }
      )
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))
      input.write('\r')

      const green = '\u001b[38;2;104;245;138m'
      await vi.waitFor(() => {
        const headingStart = headingRow.indexOf('Create a workspace')
        expect(headingRow.lastIndexOf(green, headingStart)).toBeGreaterThanOrEqual(0)
        expect(headingRow.lastIndexOf(green, headingRow.indexOf('Project harness'))).toBeGreaterThan(headingStart)
      })
    } finally {
      chalk.level = level
    }
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
    await vi.waitFor(() => expect(text()).toContain('Create a workspace'))

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
        folderFor: () => ({ path: '/work/strands-dev', detected: false }),
        onSelect: selected,
      }),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Create a workspace'))
    input.write('\r')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Folder is busy'))
    expect(frame().join('\n')).toContain('Create a workspace')

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
        folderFor: () => ({ path: '/work/strands-dev-2', detected: false }),
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
            ? { path: '/launch/strands-dev', detected: false }
            : choice.kind === 'discovered'
              ? { path: `${choice.harness.root}/strands-dev`, detected: false }
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
    expect(text()).not.toContain('Create a workspace')
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
    [9, false, false],
    [10, false, true],
    [7, true, false],
    [8, true, true],
  ])(
    'shouldShowTheSelectedProjectOnlyWhenTheFolderStepFitsAt%sRowsWithDetected%s',
    async (rows, detected, agentVisible) => {
      const input = ttyInput()
      const output = ttyOutput(120, 50)
      const frame = captureFrame(output)
      render(
        createElement(
          StartupContentRows,
          { value: rows },
          createElement(HarnessPicker, {
            harnesses: [harness],
            folderFor: () => ({ path: '/work/strands-dev', detected }),
            onSelect: vi.fn(),
          })
        ),
        { stdin: input, stdout: output }
      )
      await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))
      input.write('\r')

      await vi.waitFor(() =>
        expect(frame().join('\n')).toContain(detected ? 'Select a workspace' : 'Create a workspace')
      )
      expect(frame().join('\n').includes('Selected project')).toBe(agentVisible)
      expect(frame().length).toBeLessThanOrEqual(rows)
    }
  )

  it('shouldShowTheSearchLineInsideDiscoveredProjectsBelowTheCliDefault', async () => {
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const props = { cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' }, onSelect: vi.fn() }
    const instance = render(createElement(HarnessPicker, { ...props, harnesses: [], discovery: 'running' }), {
      stdin: ttyInput(),
      stdout: output,
    })
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Searching for local harnesses…'))
    const row = (text: string): number => frame().findIndex((line) => line.includes(text))
    expect(row('CLI DEFAULT')).toBeLessThan(row('DISCOVERED PROJECTS'))
    expect(row('DISCOVERED PROJECTS')).toBeLessThan(row('Searching for local harnesses…'))
    expect(row('Searching for local harnesses…')).toBeLessThan(row('NEW PROJECT'))
    expect(frame().join('\n')).toContain('1 / 2')
    const searchLine = frame()[row('Searching for local harnesses…')]!
    expect(searchLine.search(/\S/u)).toBe(frame()[row('Base CLI')]!.indexOf('›'))

    instance.rerender(createElement(HarnessPicker, { ...props, harnesses: [harness], discovery: 'running' }))
    await vi.waitFor(() => expect(frame().join('\n')).toContain('1 found'))
    expect(row('Project harness')).toBeLessThan(row('Searching for local harnesses…'))

    instance.rerender(createElement(HarnessPicker, { ...props, harnesses: [harness], discovery: 'done' }))

    await vi.waitFor(() => expect(frame().join('\n')).not.toContain('Searching for local harnesses…'))
    expect(frame().join('\n')).toContain('DISCOVERED PROJECTS (1)')
  })

  it('shouldSayNoHarnessesWereFoundWhenTheSearchEndsEmpty', async () => {
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    render(
      createElement(HarnessPicker, {
        cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' },
        harnesses: [],
        discovery: 'done',
        onSelect: vi.fn(),
      }),
      { stdin: ttyInput(), stdout: output }
    )

    await vi.waitFor(() => expect(frame().join('\n')).toContain('No local harnesses found.'))
    expect(frame().join('\n')).toContain('DISCOVERED PROJECTS')
  })

  it('shouldKeepTheSelectedRowWhenAHarnessArrivesAboveIt', async () => {
    const input = ttyInput()
    const output = ttyOutput(100, 36)
    const frame = captureFrame(output)
    const props = { cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' }, onSelect: vi.fn() }
    const instance = render(createElement(HarnessPicker, { ...props, harnesses: [], discovery: 'running' }), {
      stdin: input,
      stdout: output,
    })
    await vi.waitFor(() => expect(frame().join('\n')).toContain('1 / 2'))
    input.write('\u001b[B')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('› Create a new harness'))

    instance.rerender(createElement(HarnessPicker, { ...props, harnesses: [harness], discovery: 'running' }))

    await vi.waitFor(() => expect(frame().join('\n')).toContain('3 / 3'))
    expect(frame().join('\n')).toContain('› Create a new harness')
  })

  const shownPickers = (show: ReturnType<typeof vi.fn>) =>
    show.mock.calls
      .map(([content]) => content as { type: unknown; props: Parameters<typeof HarnessPicker>[0] } | undefined)
      .filter((content) => content?.type === HarnessPicker)
      .map((content) => content!.props)

  it('shouldOpenTheSelectorBeforeTheSearchEndsAndAddHarnessesAsTheyAreFound', async () => {
    const show = vi.fn()
    let report: (found: DiscoveredHarness) => void = () => undefined
    let finish: () => void = () => undefined
    let searchSignal: AbortSignal | undefined
    const running = chooseHarness(
      {
        cli: { name: 'Saved profile' },
        harnesses: [],
        search: (found, signal) => {
          report = found
          searchSignal = signal
          return new Promise((resolve) => {
            finish = () => resolve([])
          })
        },
      },
      { signal: new AbortController().signal, show },
      vi.fn()
    )

    expect(shownPickers(show)).toHaveLength(1)
    expect(shownPickers(show)[0]).toMatchObject({ harnesses: [], discovery: 'running' })
    report(harness)
    await vi.waitFor(() => expect(shownPickers(show).at(-1)?.harnesses).toEqual([harness]))
    expect(shownPickers(show).at(-1)?.discovery).toBe('running')
    finish()
    await vi.waitFor(() => expect(shownPickers(show).at(-1)?.discovery).toBe('done'))
    await shownPickers(show).at(-1)!.onSelect(undefined)

    expect(await running).toBeUndefined()
    expect(searchSignal?.aborted).toBe(true)
  })

  it('shouldShowWhyTheSearchStoppedWhenItFails', async () => {
    const show = vi.fn()
    const running = chooseHarness(
      {
        cli: { name: 'Saved profile' },
        harnesses: [],
        search: async () => {
          throw new Error('EACCES: permission denied, scandir /root')
        },
      },
      { signal: new AbortController().signal, show },
      vi.fn()
    )

    await vi.waitFor(() =>
      expect(shownPickers(show).at(-1)).toMatchObject({
        discovery: { failed: 'EACCES: permission denied, scandir /root' },
      })
    )
    await shownPickers(show).at(-1)!.onSelect(undefined)
    expect(await running).toBeUndefined()
  })
})
