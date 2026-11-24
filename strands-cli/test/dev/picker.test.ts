import chalk from 'chalk'
import { createElement } from 'react'
import { Box } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFolderInUse } from '../../src/dev/errors.js'
import {
  chooseHarness,
  editHarnessName,
  HARNESS_NAME_RULE,
  harnessNameProblem,
  HarnessPicker,
  WorkspaceReplacementConfirmation,
} from '../../src/dev/picker.js'
import type { DiscoveredHarness } from '../../src/dev/search.js'
import * as terminal from '../../src/terminal/terminal.js'
import { sanitizeTerminalText } from '../../src/terminal/text.js'
import { StartupContentRows } from '../../src/ui/startup.js'
import { captureFrame, mouseInputSequence, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const harness = {
  name: 'Project harness',
  entrypoint: '/project/agent.py',
  root: '/project',
  language: 'python' as const,
}

afterEach(() => vi.restoreAllMocks())

type PickerProps = Parameters<typeof HarnessPicker>[0]

const cli = { name: 'Saved profile', path: '/home/test/.strands/cli.toml' }

/** Renders the picker with one found harness; `rows` are the rows the startup screen gives it. */
const mount = (
  props: Partial<PickerProps> = {},
  { columns = 100, height = 36, rows }: { columns?: number; height?: number; rows?: number } = {}
) => {
  const input = ttyInput()
  const output = ttyOutput(columns, height)
  const frame = captureFrame(output)
  const selected = vi.fn()
  const picker = (next: Partial<PickerProps> = {}) =>
    createElement(HarnessPicker, { harnesses: [harness], onSelect: selected, ...props, ...next })
  const instance = render(
    rows === undefined ? picker() : createElement(StartupContentRows, { value: rows }, picker()),
    { stdin: input, stdout: output }
  )
  const rerender = (next: Partial<PickerProps>): void => instance.rerender(picker(next))
  return { input, output, frame, text: () => frame().join('\n'), selected, instance, rerender }
}

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
          cli,
          folderFor: () => ({ path: '/work/base-cli', detected: false }),
          harnesses: [harness],
          onSelect: vi.fn(),
        })
      ),
      { stdin: input, stdout: output }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Changes here also change plain strands.'))
    const positions = (): number[] =>
      ['Select a harness', 'Global Harness', 'Project harness', 'New Harness', '↑↓ select'].map((text) =>
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
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Changes here also change plain strands.'))
    expect(positions()).toEqual(initial)
  })

  it('shouldKeepEveryChoiceReachableWhenTheTerminalIsSmall', async () => {
    const { input, text, selected } = mount(
      {
        cli,
      },
      { columns: 60, height: 10 }
    )
    await vi.waitFor(() => expect(text()).toContain('Base CLI'))
    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Project harness'))
    expect(text()).toContain('/project/agent.py')
    input.write('\r')
    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'discovered', harness }))
  })

  it('shouldSelectTheBaseCliWhenTheFirstChoiceIsAccepted', async () => {
    const { input, frame, selected } = mount({ cli })
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))

    const text = frame().join('\n')
    expect(text.indexOf('Base CLI')).toBeLessThan(text.indexOf('Project harness'))
    expect(text).toContain('Source: /home/test/.strands/cli.toml')
    expect(text).toContain('Changes here also change plain strands.')
    expect(text).toContain('They save into ~/.strands/cli.toml, or into the agent file that it uses.')
    expect(text).toContain('Global Harness')
    expect(text).toContain('Discovered Harnesses (1)')
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'cli' }))
  })

  it('shouldOfferCreationWhenOnlyTheBaseCliExists', async () => {
    const { input, text, selected } = mount({
      cli,
      harnesses: [],
    })
    await vi.waitFor(() => expect(text()).toContain('Create a new harness'))

    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Create a new harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Language: python'))
    input.write('\t')
    await vi.waitFor(() => expect(text()).toContain('Language: typescript'))
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'create', name: 'new-harness', language: 'typescript' })
    )
  })

  it('shouldNotTypeTheMouseReportsOfTheTerminalIntoTheNameOfANewHarness', async () => {
    const { input, text, selected } = mount({
      cli,
      harnesses: [],
    })
    await vi.waitFor(() => expect(text()).toContain('Create a new harness'))
    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Create a new harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Name: new-harness'))

    input.write('-2')
    input.write(mouseInputSequence(64, 49, 19, 'M') + mouseInputSequence(35, 49, 19, 'M'))
    input.write('b')
    await vi.waitFor(() => expect(text()).toContain('Name: new-harness-2b'))
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'create', name: 'new-harness-2b', language: 'python' })
    )
  })

  it('shouldHideTheBaseCliAndWarnWhenNoCliOptionIsGiven', async () => {
    const { input, frame, selected } = mount({
      warning: 'When you select an agent, strands dev deletes your current agent.',
    })
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Select a harness'))

    const text = frame().join('\n')
    expect(text).toContain('When you select an agent, strands dev deletes your current agent.')
    expect(text).not.toContain('Base CLI')
    expect(text).not.toContain('Global Harness')
    expect(text).toContain('1 / 2')
    expect(text).toContain('Source: /project/agent.py')
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'discovered', harness }))
  })

  it('shouldKeepTheWarningVisibleWhileCreatingAHarness', async () => {
    const { input, text, selected } = mount({
      harnesses: [],
      warning: 'When you select an agent, strands dev deletes your current agent.',
    })
    await vi.waitFor(() => expect(text()).toContain('› Create a new harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Create a harness'))

    expect(text()).toContain('When you select an agent, strands dev deletes your current agent.')
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'create', name: 'new-harness', language: 'python' })
    )
  })

  const withFolder = (harnesses: (typeof harness)[] = [harness]) =>
    mount({ cli, harnesses, folderFor: () => ({ path: '/work/strands-dev', detected: false }) })

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

  it('shouldOpenTheDetectedWorkspaceWithoutAskingForAFolder', async () => {
    const { input, text, selected } = mount({
      cli,
      harnesses: [],
      folderFor: () => ({ path: '/home/test/.strands/strands-dev', detected: true }),
    })
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    expect(text()).toContain('Enter open')

    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'cli' }, '/home/test/.strands/strands-dev'))
    expect(text()).not.toContain('Create a workspace')
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

  it('shouldColorTheHeadingAndContextGreenWhenTheFolderStepIsShown', async () => {
    const level = chalk.level
    chalk.level = 3
    try {
      const { input, output, text } = mount({
        folderFor: () => ({ path: '/work/strands-dev', detected: false }),
      })
      let headingRow = ''
      output.on('data', (chunk: Buffer) => {
        headingRow =
          chunk
            .toString()
            .split('\n')
            .find((line) => sanitizeTerminalText(line).includes('Create a workspace')) ?? headingRow
      })
      await vi.waitFor(() => expect(text()).toContain('Select a harness'))
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

  it('shouldAskForTheFolderWithoutASelectedProjectAfterTheNewHarnessForm', async () => {
    const { input, text, selected } = withFolder([])
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Create a new harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Tab language · Enter continue'))
    input.write('\r')

    await vi.waitFor(() => expect(text()).toContain('New project · new-harness'))
    expect(text()).not.toContain('Selected project')
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith(
        { kind: 'create', name: 'new-harness', language: 'python' },
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
    const selected = vi.fn().mockRejectedValueOnce(new Error('Folder is busy')).mockResolvedValueOnce(undefined)
    const { input, text } = mount({
      cli,
      harnesses: [],
      folderFor: () => ({ path: '/work/strands-dev', detected: false }),
      onSelect: selected,
    })
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Create a workspace'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Folder is busy'))
    expect(text()).toContain('Create a workspace')

    input.write('/other')
    await vi.waitFor(() => expect(text()).toContain('Workspace folder: /work/other'))
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenLastCalledWith({ kind: 'cli' }, '/work/other'))
    expect(selected).toHaveBeenNthCalledWith(1, { kind: 'cli' }, '/work/strands-dev')
    expect(selected).toHaveBeenCalledTimes(2)
  })

  const withOccupiedFolder = (selected: PickerProps['onSelect']) => {
    const { input, frame } = mount(
      {
        cli,
        harnesses: [],
        folderFor: () => ({
          path: '/home/test/.strands/strands-dev',
          detected: false,
          occupiedBy: 'Strands harness (/desk/agent.py)',
        }),
        onSelect: selected,
      },
      { height: 40 }
    )
    return { input, text: () => frame().join('\n').replace(/\s+/gu, ' ') }
  }
  const inUse = () => new WorkspaceFolderInUse('/home/test/.strands/strands-dev', 'Strands harness (/desk/agent.py)')

  it('shouldSayTheSuggestedFolderHoldsAnotherWorkspaceBeforeTheUserContinues', async () => {
    const { input, text } = withOccupiedFolder(vi.fn())
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\r')

    await vi.waitFor(() =>
      expect(text()).toContain('strands-dev in this path holds the workspace of Strands harness (/desk/agent.py).')
    )
    expect(text()).toContain('Enter asks you to confirm before it is replaced.')
  })

  it('shouldReplaceTheFolderOnlyAfterTheUserTypesDelete', async () => {
    const selected = vi.fn().mockRejectedValueOnce(inUse()).mockResolvedValueOnce(undefined)
    const { input, text } = withOccupiedFolder(selected)
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Create a workspace'))
    input.write('\r')

    await vi.waitFor(() => expect(text()).toContain('DELETE workspace and replace?'))
    expect(text()).toContain('Current workspace: Strands harness (/desk/agent.py)')
    expect(text()).toContain('Replacement: Base CLI · Saved profile')
    input.write('DELET')
    await vi.waitFor(() => expect(text()).toContain('Type DELETE to confirm: DELET▏'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Type DELETE exactly to confirm'))
    expect(selected).toHaveBeenCalledTimes(1)
    input.write('E')
    await vi.waitFor(() => expect(text()).toContain('Type DELETE to confirm: DELETE▏'))
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenLastCalledWith({ kind: 'cli' }, '/home/test/.strands/strands-dev', true)
    )
    expect(selected).toHaveBeenNthCalledWith(1, { kind: 'cli' }, '/home/test/.strands/strands-dev')
  })

  it('shouldReturnToTheFolderStepWhenTheUserCancelsTheReplacement', async () => {
    const selected = vi.fn().mockRejectedValueOnce(inUse())
    const { input, text } = withOccupiedFolder(selected)
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Create a workspace'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('DELETE workspace and replace?'))

    input.write('\u001b')

    await vi.waitFor(() => expect(text()).toContain('Create a workspace'))
    expect(text()).not.toContain('DELETE workspace and replace?')
    expect(selected).toHaveBeenCalledTimes(1)
  })

  it('shouldNameTheNumberedFolderInTheNoteUntilThePathChanges', async () => {
    const { input, text } = mount({
      cli,
      harnesses: [],
      folderFor: () => ({ path: '/work/strands-dev-2', detected: false }),
    })
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toMatch(/Workspace folder: \/work▌?\s*$/m))
    expect(text()).toContain('A strands-dev-2 folder will be created in this path')

    input.write('/next')

    await vi.waitFor(() => expect(text()).toContain('A strands-dev folder will be created in this path'))
    expect(text()).not.toContain('strands-dev-2')
  })

  const withPlacement = () => {
    const other = { ...harness, name: 'Other harness', entrypoint: '/other/agent.py', root: '/other' }
    const mounted = mount({
      cli,
      harnesses: [harness, other],
      folderFor: (choice) =>
        choice.kind === 'cli'
          ? { path: '/launch/strands-dev', detected: false }
          : choice.kind === 'discovered'
            ? { path: `${choice.harness.root}/strands-dev`, detected: false }
            : undefined,
      newProject: '/launch/strands-workspace',
    })
    return { ...mounted, other }
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
    input.write('\u001b[A')
    await vi.waitFor(() => expect(text()).toContain('Source: /launch/strands-workspace'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Folder: /launch/strands-workspace'))
    expect(text()).toContain('Enter create')
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'create', name: 'new-harness', language: 'python' })
    )
    expect(text()).not.toContain('Create a workspace')
  })

  it.each([
    ['↓ from the Base CLI', ['\u001b[B'], '› Project harness'],
    ['↓ ↓ to the next discovered harness', ['\u001b[B', '\u001b[B'], '› Other harness'],
    ['↓ ↓ ↓ past the discovered section', ['\u001b[B', '\u001b[B', '\u001b[B'], '› Create a new harness'],
    ['↓ ↓ ↓ ↓ back to the Base CLI', ['\u001b[B', '\u001b[B', '\u001b[B', '\u001b[B'], '› Base CLI'],
    ['↑ from the Base CLI', ['\u001b[A'], '› Create a new harness'],
    ['↑ ↑ to the last harness', ['\u001b[A', '\u001b[A'], '› Other harness'],
    ['↓ → that does not move', ['\u001b[B', '\u001b[C'], '› Project harness'],
  ])('shouldMoveThroughEveryRowWithUpAndDownFor %s', async (_case, keys, row) => {
    const { input, text } = withPlacement()
    await vi.waitFor(() => expect(text()).toContain('› Base CLI'))

    for (const key of keys) input.write(key)

    await vi.waitFor(() => expect(text()).toContain(row))
  })

  it.each([
    ['Base CLI', []],
    ['Create a new harness', ['\u001b[A']],
  ])('shouldIgnoreLeftAndRightWhenTheSelectionIsThe %s', async (label, keys) => {
    const { input, text } = withPlacement()
    await vi.waitFor(() => expect(text()).toContain('› Base CLI'))
    for (const key of keys) input.write(key)
    await vi.waitFor(() => expect(text()).toContain(`› ${label}`))

    input.write('\u001b[C')
    input.write('\u001b[D')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(text()).toContain(`› ${label}`)
  })

  it('shouldShowEveryHarnessWithoutALeftRightHintWhenTheSectionHoldsMoreThanOneHarness', async () => {
    const { text } = withPlacement()

    await vi.waitFor(() => expect(text()).toContain('Discovered Harnesses (2)'))
    expect(text()).toContain('Project harness')
    expect(text()).toContain('Other harness')
    expect(text()).not.toContain('←→')
  })

  const createForm = async (props: Partial<PickerProps> = {}) => {
    const { input, text, selected, instance } = mount({ harnesses: [], ...props })
    await vi.waitFor(() => expect(text()).toContain('› Create a new harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('› Name: new-harness'))
    const press = async (key: string): Promise<void> => {
      input.write(key)
      await instance.waitUntilRenderFlush()
    }
    return { input, press, text, selected }
  }

  it('shouldMoveToTheLanguageFieldAndChangeItWhenArrowsArePressed', async () => {
    const { input, text, selected } = await createForm()

    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Language: python'))
    input.write('\u001b[C')
    await vi.waitFor(() => expect(text()).toContain('› Language: typescript'))
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'create', name: 'new-harness', language: 'typescript' })
    )
  })

  it('shouldShowTheModelNoticeOnlyForTheLanguageThatCannotLoadTheModelModule', async () => {
    const notice = 'Python cannot load the model module custom.mjs.'
    const { input, text } = await createForm({
      modelNotice: (language) => (language === 'typescript' ? notice : undefined),
    })

    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Language: python'))
    expect(text()).not.toContain(notice)
    input.write('\u001b[C')

    await vi.waitFor(() => expect(text()).toContain('› Language: typescript'))
    await vi.waitFor(() => expect(text()).toContain(notice))
  })

  it('shouldEditTheNameOnlyWhenTheNameFieldIsSelected', async () => {
    const { input, text, selected } = await createForm()
    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Language: python'))

    input.write('x')
    input.write('\u001b[A')
    await vi.waitFor(() => expect(text()).toContain('› Name: new-harness'))
    input.write('y')
    await vi.waitFor(() => expect(text()).toContain('Name: new-harnessy'))
    input.write('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'create', name: 'new-harnessy', language: 'python' })
    )
  })

  it('shouldTypeAtTheCursorWhenTheArrowKeysMoveItInTheName', async () => {
    const { press, text, selected } = await createForm()

    for (const key of [...Array<string>(7).fill('\u001b[D'), 'my-']) await press(key)
    await vi.waitFor(() => expect(text()).toContain('› Name: new-my-harness'))
    await press('\r')

    await vi.waitFor(() =>
      expect(selected).toHaveBeenCalledWith({ kind: 'create', name: 'new-my-harness', language: 'python' })
    )
  })

  it.each([
    ['typed input', [' /x'], 'new-harnessx'],
    ['a paste into an empty name', ['\u0015', 'support agent/v2'], 'supportagentv2'],
  ])('shouldKeepTheAllowedCharactersAndSayWhatWasRemovedWhen %s HasOthers', async (_case, keys, name) => {
    const { press, text } = await createForm()

    for (const key of keys) await press(key)

    await vi.waitFor(() => expect(text()).toContain(`› Name: ${name}`))
    expect(text()).toContain('Removed space and "/". Use letters, digits, ".", "_", and "-".')
  })

  it('shouldShowTheAllowedCharactersAgainWhenTheNextInputIsAllowed', async () => {
    const { press, text } = await createForm()
    await press(' ')
    await vi.waitFor(() => expect(text()).toContain('Removed space.'))

    await press('y')

    await vi.waitFor(() => expect(text()).toContain('› Name: new-harnessy'))
    expect(text()).toContain('Use letters, digits, ".", "_", and "-". Up to 64 characters.')
    expect(text()).not.toContain('Removed')
  })

  it.each([
    ['an empty name', ['\u0015'], 'Enter a name.'],
    ['a dot', ['\u0015', '.'], 'Enter a name other than "." or "..".'],
    ['two dots', ['\u0015', '..'], 'Enter a name other than "." or "..".'],
  ])('shouldSayWhatTheNameNeedsWhenEnterIsPressedWith %s', async (_case, keys, message) => {
    const { press, text, selected } = await createForm()
    for (const key of keys) await press(key)

    await press('\r')

    await vi.waitFor(() => expect(text()).toContain(message))
    expect(selected).not.toHaveBeenCalled()
  })

  it('shouldShowTheProjectFolderThatTheNameDoesNotChangeWhenTheProjectGoesInTheLaunchFolder', async () => {
    const { press, text } = await createForm({ newProject: '/launch/strands-workspace' })

    await press('-bot')

    await vi.waitFor(() => expect(text()).toContain('› Name: new-harness-bot'))
    expect(text()).toContain('Folder: /launch/strands-workspace')
  })

  it('shouldSayTheFolderComesNextWhenTheNewHarnessNeedsAFolder', async () => {
    const { text } = await createForm({ folderFor: () => ({ path: '/work/strands-dev', detected: false }) })

    expect(text()).toContain('Folder: chosen in the next step')
  })

  it('shouldShowLeftAndRightInTheHintOnlyWhenTheLanguageFieldIsSelected', async () => {
    const { input, text } = await createForm()
    expect(text()).toContain('↑↓ field · Tab language · Enter')

    input.write('\u001b[B')

    await vi.waitFor(() => expect(text()).toContain('↑↓ field · ←→ or Tab language · Enter'))
  })

  it('shouldCopyTheFullOpenFailureWhenControlYIsPressed', async () => {
    const copy = vi.spyOn(terminal, 'copyTerminalText').mockResolvedValue(true)
    const reason = `Reason: ${'missing dependency '.repeat(12)}`
    const { input, text } = mount({
      cli,
      onSelect: vi.fn().mockRejectedValue(new Error(reason)),
    })
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    expect(text()).not.toContain('Ctrl+Y copy error')

    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Ctrl+Y copy error'))
    input.write('\u0019')

    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
    const copied = copy.mock.calls[0]![0]
    expect(copied).toContain('Workspace could not open.')
    expect(copied).toContain(reason.trim())
    await vi.waitFor(() => expect(text()).toContain(`${copied.length} chars copied to clipboard`))
  })

  const manyProjects = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      ...harness,
      name: `Project ${index + 1}`,
      entrypoint: `/project-${index + 1}/agent.py`,
    }))

  const renderProjects = (rows: number, projects: readonly DiscoveredHarness[], withFolders = false) => {
    const { input, frame } = mount(
      {
        cli: { name: 'Saved profile' },
        harnesses: projects,
        ...(withFolders ? { folderFor: () => ({ path: '/work/strands-dev', detected: false }) } : {}),
      },
      { height: 50, rows }
    )
    const shownProjects = (): string[] => frame().flatMap((line) => line.match(/Project \d+/u) ?? [])
    return { input, frame, shownProjects }
  }

  it.each([10, 12, 16, 24, 40])('shouldPinBothActionsWhileProjectsScrollWithin%sRows', async (rows) => {
    const projects = manyProjects(12)
    const { input, frame } = renderProjects(rows, projects)
    const expectSections = (): void => {
      const text = frame().join('\n')
      expect(text).toContain('Base CLI')
      expect(text).toContain('Discovered Harnesses (12)')
      expect(text).toContain('Create a new harness')
      expect(text).not.toContain('←→')
      expect(frame().length).toBeLessThanOrEqual(rows)
    }
    await vi.waitFor(() => expect(frame().join('\n')).toContain('› Base CLI'))
    expectSections()
    for (const project of projects) {
      input.write('\u001b[B')
      await vi.waitFor(() => expect(frame().join('\n')).toContain(`› ${project.name} `))
      expectSections()
    }
    input.write('\u001b[B')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('› Create a new harness'))
    expectSections()
    input.write('\u001b[B')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('› Base CLI'))
    expectSections()
    input.write('\u001b[A')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('› Create a new harness'))
    expectSections()
  })

  it('shouldShowAsManyHarnessesAsFitWhenTheListMustScroll', async () => {
    const { frame, shownProjects } = renderProjects(15, manyProjects(8), true)

    await vi.waitFor(() => expect(frame().join('\n')).toContain('› Base CLI'))

    expect(shownProjects()).toEqual(['Project 1', 'Project 2', 'Project 3', 'Project 4', 'Project 5', 'Project 6'])
    expect(frame().join('\n')).toContain('Discovered Harnesses (8) · 1–6 of 8')
    expect(frame().join('\n')).toContain('Source: ')
    expect(frame().join('\n')).toContain('Workspace: /work/strands-dev')
    expect(frame().length).toBeLessThanOrEqual(15)
  })

  it.each([24, 40])('shouldShowEveryHarnessWithoutARangeWhenAllFitWithin%sRows', async (rows) => {
    const { frame, shownProjects } = renderProjects(rows, manyProjects(12))

    await vi.waitFor(() => expect(frame().join('\n')).toContain('› Base CLI'))

    expect(shownProjects()).toHaveLength(12)
    expect(frame().join('\n')).not.toContain('of 12')
    expect(frame().length).toBeLessThanOrEqual(rows)
  })

  it('shouldScrollOnlyWhenTheSelectionLeavesTheShownHarnesses', async () => {
    const { input, frame, shownProjects } = renderProjects(12, manyProjects(12))
    await vi.waitFor(() => expect(frame().join('\n')).toContain('› Base CLI'))
    const capacity = shownProjects().length
    for (const _ of Array.from({ length: capacity + 1 })) input.write('\u001b[B')
    await vi.waitFor(() => expect(frame().join('\n')).toContain(`› Project ${capacity + 1} `))
    const scrolled = shownProjects()

    input.write('\u001b[A')

    await vi.waitFor(() => expect(frame().join('\n')).toContain(`› Project ${capacity} `))
    expect(shownProjects()).toEqual(scrolled)
    expect(scrolled[0]).toBe('Project 2')
  })

  it.each([12, 16, 24])('shouldAlignTitlesAndWorkspaceDetailsWithin%sRows', async (rows) => {
    const { input, frame } = mount(
      {
        cli,
        folderFor: (choice) => ({ path: choice.kind === 'cli' ? '/work/base' : '/work/project', detected: true }),
      },
      { height: 50, rows }
    )
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Workspace: /work/base'))
    const assertAlignment = (): void => {
      const lines = frame()
      const line = (text: string): string => lines.find((entry) => entry.includes(text))!
      const titles = ['Global Harness', 'Discovered Harnesses', 'New Harness', 'Source:', 'Workspace:']
      const left = line(titles[0]!).search(/\S/u)
      for (const title of titles) expect(line(title).search(/\S/u)).toBe(left)
      expect(line('Base CLI').indexOf('Base CLI')).toBeGreaterThan(left)
      expect(line('Project harness').indexOf('Project harness')).toBeGreaterThan(left)
      expect(line('Create a new harness').indexOf('Create a new harness')).toBeGreaterThan(left)
      expect(lines.length).toBeLessThanOrEqual(rows)
    }
    assertAlignment()
    input.write('\u001b[B')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Workspace: /work/project'))
    expect(frame().join('\n')).toContain('Source: /project/agent.py')
    assertAlignment()
  })

  it.each([10, 12, 16, 24])('shouldSeparateTheSectionsAndSourceWithin%sRows', async (rows) => {
    const { input, frame, text } = mount(
      {
        cli: { name: 'Saved profile' },
        harnesses: [],
        discovery: 'running',
      },
      { height: 50, rows }
    )
    const expectSpacing = (): void => {
      const lines = frame()
      const base = lines.findIndex((line) => line.includes('Base CLI'))
      const projects = lines.findIndex((line) => line.includes('Discovered Harnesses'))
      const searching = lines.findIndex((line) => line.includes('Searching for local harnesses'))
      const create = lines.findIndex((line) => line.includes('Create a new harness'))
      expect(projects).toBe(base + (rows >= 12 ? 2 : 1))
      expect(lines[base - 1]).toContain('Global Harness')
      expect(lines[create - 1]).toContain('New Harness')
      if (rows >= 12) {
        expect(lines[base + 1]?.trim()).toBe('')
        expect(lines[searching + 1]?.trim()).toBe('')
      }
      if (rows >= 16) expect(lines[create + 1]?.trim()).toBe('')
      expect(lines.length).toBeLessThanOrEqual(rows)
    }
    await vi.waitFor(() => expect(text()).toContain('› Base CLI'))
    expectSpacing()
    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Create a new harness'))
    expectSpacing()
  })

  it.each(['running', { failed: 'Search unavailable' }] as const)(
    'shouldNotCountDiscoveryStatusAsAProjectWhenDiscoveryIs%j',
    async (discovery) => {
      const { input, frame, text } = mount(
        {
          cli: { name: 'Saved profile' },
          harnesses: manyProjects(12),
          discovery,
        },
        { height: 50, rows: 12 }
      )
      await vi.waitFor(() => expect(text()).toContain('› Base CLI'))
      expect(text()).toMatch(/1–\d+ of 12/)
      expect(text()).toContain(discovery === 'running' ? 'Searching for local harnesses' : 'Search stopped')
      expect(frame().length).toBeLessThanOrEqual(12)
      input.write('\u001b[A')
      await vi.waitFor(() => expect(text()).toContain('› Create a new harness'))
      expect(text()).toMatch(/1–\d+ of 12/)
      input.write('\u001b[A')
      input.write('\u001b[D')
      await vi.waitFor(() => expect(text()).toContain('› Project 12 '))
      expect(text()).toMatch(/\d+–12 of 12/)
      expect(frame().length).toBeLessThanOrEqual(12)
    }
  )

  it.each(['running', 'done', { failed: 'Search unavailable' }] as const)(
    'shouldKeepAllSectionsVisibleWithoutProjectsWhenDiscoveryIs%j',
    async (discovery) => {
      const { input, frame, selected } = mount(
        { cli: { name: 'Saved profile' }, harnesses: [], discovery },
        { height: 50, rows: 12 }
      )
      await vi.waitFor(() => expect(frame().join('\n')).toContain('› Base CLI'))
      const text = frame().join('\n')
      expect(text).toContain('Discovered Harnesses')
      expect(text).toContain(
        discovery === 'running'
          ? 'Searching for local harnesses'
          : discovery === 'done'
            ? 'No local harnesses found.'
            : 'Search stopped'
      )
      expect(text).toContain('Create a new harness')
      expect(frame().length).toBeLessThanOrEqual(12)
      input.write('\u001b[B')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('› Create a new harness'))
      input.write('\u001b[A')
      await vi.waitFor(() => expect(frame().join('\n')).toContain('› Base CLI'))
      input.write('\r')
      await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'cli' }))
    }
  )

  const renderWithRows = (rows: number, warning?: string): (() => string[]) => {
    const { frame } = mount(
      {
        cli,
        harnesses: [harness, { ...harness, name: 'Other harness', entrypoint: '/other/agent.py' }],
        ...(warning ? { warning } : {}),
      },
      { columns: 120, height: 50, rows }
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

    expect(frame().join('\n').includes('Changes here also change plain strands.')).toBe(notesVisible)
  })

  it.each([
    [9, false],
    [10, true],
  ])('shouldShowTheSelectedProjectOnlyWhenTheFolderStepFitsAt%sRows', async (rows, agentVisible) => {
    const { input, frame, text } = mount(
      {
        folderFor: () => ({ path: '/work/strands-dev', detected: false }),
      },
      { columns: 120, height: 50, rows }
    )
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\r')

    await vi.waitFor(() => expect(text()).toContain('Create a workspace'))
    expect(text().includes('Selected project')).toBe(agentVisible)
    expect(frame().length).toBeLessThanOrEqual(rows)
  })

  it('shouldShowTheSearchLineInsideDiscoveredProjectsBelowTheCliDefault', async () => {
    const { frame, rerender } = mount({ cli, harnesses: [], discovery: 'running' })
    await vi.waitFor(() => expect(frame().join('\n')).toContain('Searching for local harnesses…'))
    const row = (text: string): number => frame().findIndex((line) => line.includes(text))
    expect(row('Global Harness')).toBeLessThan(row('Discovered Harnesses'))
    expect(row('Discovered Harnesses')).toBeLessThan(row('Searching for local harnesses…'))
    expect(row('Searching for local harnesses…')).toBeLessThan(row('New Harness'))
    expect(frame().join('\n')).toContain('1 / 2')
    const searchLine = frame()[row('Searching for local harnesses…')]!
    expect(searchLine.search(/\S/u)).toBe(frame()[row('Base CLI')]!.indexOf('Base CLI'))

    rerender({ harnesses: [harness], discovery: 'running' })
    await vi.waitFor(() => expect(frame().join('\n')).toContain('1 found'))
    expect(row('Project harness')).toBeLessThan(row('Searching for local harnesses…'))

    rerender({ harnesses: [harness], discovery: 'done' })

    await vi.waitFor(() => expect(frame().join('\n')).not.toContain('Searching for local harnesses…'))
    expect(frame().join('\n')).toContain('Discovered Harnesses (1)')
  })

  it('shouldSayNoHarnessesWereFoundAndStaySilentAboutSkippedSourcesWhenTheSearchEndsEmpty', async () => {
    const { text } = mount({ cli, harnesses: [], discovery: 'done' })

    await vi.waitFor(() => expect(text()).toContain('No local harnesses found.'))
    expect(text()).toContain('Discovered Harnesses')
    expect(text()).not.toContain('Skipped')
  })

  it('shouldKeepTheSelectedRowWhenAHarnessArrivesAboveIt', async () => {
    const { input, text, rerender } = mount({ cli, harnesses: [], discovery: 'running' })
    await vi.waitFor(() => expect(text()).toContain('1 / 2'))
    input.write('\u001b[B')
    await vi.waitFor(() => expect(text()).toContain('› Create a new harness'))

    rerender({ harnesses: [harness], discovery: 'running' })

    await vi.waitFor(() => expect(text()).toContain('3 / 3'))
    expect(text()).toContain('› Create a new harness')
  })

  it('shouldShowTheRefreshKeyOnTheDiscoveredHarnessesHeadingWhenThePickerCanSearchAgain', async () => {
    const { frame, text } = mount({
      cli,
      discovery: 'done',
      onRefresh: vi.fn(),
    })

    await vi.waitFor(() => expect(text()).toContain('Discovered Harnesses (1)'))
    expect(frame().find((line) => line.includes('Discovered Harnesses (1)'))).toMatch(
      /Discovered Harnesses \(1\)\s+r refresh/u
    )
  })

  it('shouldLeaveTheRefreshKeyOutWhenThePickerCannotSearch', async () => {
    const { text } = mount({
      cli,
    })

    await vi.waitFor(() => expect(text()).toContain('Discovered Harnesses (1)'))
    expect(text()).not.toContain('r refresh')
  })

  it('shouldAskForANewSearchWhenTheUserPressesR', async () => {
    const onRefresh = vi.fn()
    const { input, text } = mount({
      cli,
      discovery: 'done',
      onRefresh,
    })
    await vi.waitFor(() => expect(text()).toContain('r refresh'))

    input.write('r')

    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1))
  })

  it('shouldTypeRIntoTheNameWhenTheNewHarnessFormIsOpen', async () => {
    const onRefresh = vi.fn()
    const { input, text } = mount({
      harnesses: [],
      discovery: 'done',
      onRefresh,
    })
    await vi.waitFor(() => expect(text()).toContain('Create a new harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Create a harness'))

    input.write('r')

    await vi.waitFor(() => expect(text()).toContain('new-harnessr'))
    expect(onRefresh).not.toHaveBeenCalled()
  })

  /** Opens the selector with `search`. `shown` lists the pickers it showed, and `close` cancels the selection. */
  const choosing = (search: NonNullable<Parameters<typeof chooseHarness>[0]['search']>) => {
    const show = vi.fn()
    const running = chooseHarness(
      { cli: { name: 'Saved profile' }, harnesses: [], search },
      { signal: new AbortController().signal, show },
      vi.fn()
    )
    const shown = () =>
      show.mock.calls
        .map(([content]) => content as { type: unknown; props: PickerProps } | undefined)
        .filter((content) => content?.type === HarnessPicker)
        .map((content) => content!.props)
    const close = async (): Promise<void> => {
      await shown().at(-1)!.onSelect(undefined)
      expect(await running).toBeUndefined()
    }
    return { shown, close }
  }

  it('shouldOpenTheSelectorBeforeTheSearchEndsAndAddHarnessesAsTheyAreFound', async () => {
    let report: (found: DiscoveredHarness) => void = () => undefined
    let finish: () => void = () => undefined
    let searchSignal: AbortSignal | undefined
    const { shown, close } = choosing((found, signal) => {
      report = found
      searchSignal = signal
      return new Promise((resolve) => {
        finish = () => resolve({ harnesses: [] })
      })
    })

    expect(shown()).toHaveLength(1)
    expect(shown()[0]).toMatchObject({ harnesses: [], discovery: 'running' })
    report(harness)
    await vi.waitFor(() => expect(shown().at(-1)?.harnesses).toEqual([harness]))
    expect(shown().at(-1)?.discovery).toBe('running')
    finish()
    await vi.waitFor(() => expect(shown().at(-1)?.discovery).toBe('done'))
    await close()

    expect(searchSignal?.aborted).toBe(true)
  })

  it('shouldSearchAgainAndShowOnlyTheHarnessesItFindsWhenThePickerAsksForARefresh', async () => {
    const edited = { ...harness, name: 'Edited harness' }
    const downloaded = { ...harness, name: 'Downloaded harness', entrypoint: '/downloads/agent.ts', root: '/downloads' }
    const results = [
      { harnesses: [harness, { ...harness, entrypoint: '/old/agent.py', root: '/old' }] },
      { harnesses: [edited, downloaded] },
    ]
    const search = vi.fn(async () => results.shift()!)
    const { shown, close } = choosing(search)
    await vi.waitFor(() => expect(shown().at(-1)?.discovery).toBe('done'))

    shown().at(-1)!.onRefresh!()

    expect(shown().at(-1)).toMatchObject({ harnesses: [], discovery: 'running' })
    await vi.waitFor(() => expect(shown().at(-1)?.discovery).toBe('done'))
    expect(shown().at(-1)?.harnesses).toEqual([edited, downloaded])
    expect(search).toHaveBeenCalledTimes(2)
    await close()
  })

  it('shouldStopTheRunningSearchAndIgnoreItsLateResultsWhenThePickerAsksForARefresh', async () => {
    const searches: { report: (found: DiscoveredHarness) => void; signal: AbortSignal; finish: () => void }[] = []
    const { shown, close } = choosing(
      (found, signal) =>
        new Promise((resolve) => {
          searches.push({ report: found, signal, finish: () => resolve({ harnesses: [] }) })
        })
    )
    await vi.waitFor(() => expect(searches).toHaveLength(1))

    shown().at(-1)!.onRefresh!()
    await vi.waitFor(() => expect(searches).toHaveLength(2))
    searches[0]!.report({ ...harness, name: 'Stale harness' })
    searches[0]!.finish()
    searches[1]!.report(harness)
    searches[1]!.finish()

    await vi.waitFor(() => expect(shown().at(-1)?.discovery).toBe('done'))
    expect(searches[0]!.signal.aborted).toBe(true)
    expect(searches[1]!.signal.aborted).toBe(false)
    expect(shown().at(-1)?.harnesses).toEqual([harness])
    await close()
    expect(searches[1]!.signal.aborted).toBe(true)
  })

  it('shouldShowWhyTheSearchStoppedWhenItFails', async () => {
    const { shown, close } = choosing(async () => {
      throw new Error('EACCES: permission denied, scandir /root')
    })

    await vi.waitFor(() =>
      expect(shown().at(-1)).toMatchObject({
        discovery: { failed: 'EACCES: permission denied, scandir /root' },
      })
    )
    await close()
  })
})

describe('WorkspaceReplacementConfirmation', () => {
  const confirmation = (replacement = 'Other agent · /agents/other/agent.ts') => {
    const input = ttyInput()
    const output = ttyOutput(120, 35)
    const frame = captureFrame(output)
    const confirm = vi.fn()
    const cancel = vi.fn()
    render(
      createElement(WorkspaceReplacementConfirmation, {
        directory: '/workspace/strands-dev',
        replacement,
        onConfirm: confirm,
        onCancel: cancel,
      }),
      { stdin: input, stdout: output }
    )
    return { input, text: () => frame().join('\n'), confirm, cancel }
  }

  it('shouldNotTypeTheMouseReportsOfTheTerminalIntoTheConfirmation', async () => {
    const { input, text, confirm } = confirmation()
    await vi.waitFor(() => expect(text()).toContain('This is a DELETE operation.'))

    input.write('DEL')
    await vi.waitFor(() => expect(text()).toContain('confirm: DEL▏'))
    input.write(mouseInputSequence(64, 49, 19, 'M') + mouseInputSequence(35, 49, 19, 'M'))
    input.write('ETE')
    await vi.waitFor(() => expect(text()).toContain('confirm: DELETE▏'))
    input.write('\r')

    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
  })

  it('shouldRequireTypedDeleteBeforeConfirmingTheReplacement', async () => {
    const { input, text, confirm, cancel } = confirmation()
    await vi.waitFor(() => expect(text()).toContain('This is a DELETE operation.'))
    expect(text()).toContain('/workspace/strands-dev')
    expect(text()).toContain('All files in this folder will be replaced')
    expect(text()).toContain('outside this folder will not be deleted')
    expect(text()).toContain('Replacement: Other agent · /agents/other/agent.ts')
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Type DELETE exactly'))
    expect(confirm).not.toHaveBeenCalled()
    input.write('DELETE')
    await vi.waitFor(() => expect(text()).toContain('confirm: DELETE'))
    input.write('\r')
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(cancel).not.toHaveBeenCalled()
  })

  it('shouldCopyTheConfirmationErrorWithoutTypingIntoTheApprovalWhenControlYIsPressed', async () => {
    const copy = vi.spyOn(terminal, 'copyTerminalText').mockResolvedValue(true)
    const { input, text } = confirmation()
    await vi.waitFor(() => expect(text()).toContain('This is a DELETE operation.'))
    input.write('DEL')
    await vi.waitFor(() => expect(text()).toContain('confirm: DEL▏'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Enter confirm · Ctrl+Y copy error · Esc back'))

    input.write('\u0019')

    await vi.waitFor(() => expect(copy).toHaveBeenCalledOnce())
    expect(copy.mock.calls[0]![0]).toBe('Type DELETE exactly to confirm, or press Esc to select a different agent.')
    expect(text()).toContain('confirm: DEL▏')
    copy.mockRestore()
  })

  it('shouldGoBackWithoutConfirmingWhenEscapeIsPressed', async () => {
    const { input, text, confirm, cancel } = confirmation('New typescript agent · new-harness')
    await vi.waitFor(() => expect(text()).toContain('DELETE workspace and replace?'))
    input.write('\u001b')
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
    expect(confirm).not.toHaveBeenCalled()
  })
})

const allowedCharacters = 'Use letters, digits, ".", "_", and "-".'
const atEnd = (value: string) => ({ value, cursor: value.length })

describe('editHarnessName', () => {
  it.each(['x', 'my-agent', 'v1.2_beta', 'ABC123'])('shouldInsertTheInputWhenEveryCharacterIsAllowed %s', (input) => {
    expect(editHarnessName(atEnd('name-'), input, {})).toEqual(atEnd(`name-${input}`))
  })

  it.each([
    [' ', 'name', 'space'],
    ['/', 'name', '"/"'],
    [' /x', 'namex', 'space and "/"'],
    ['support agent/v2', 'namesupportagentv2', 'space and "/"'],
    ['a\tb', 'nameab', 'tab'],
    ['bot\n', 'namebot', 'line break'],
    ['café', 'namecaf', '"é"'],
    ['a b c#', 'nameabc', 'space and "#"'],
    ['a\u0000b', 'nameab', 'control character'],
    ['a\u200bb', 'nameab', 'invisible character'],
  ])('shouldKeepTheAllowedCharactersAndNameTheRemovedOnesWhenTheInputIs %j', (input, value, removed) => {
    expect(editHarnessName(atEnd('name'), input, {})).toEqual({
      ...atEnd(value),
      notice: `Removed ${removed}. ${allowedCharacters}`,
    })
  })

  it('shouldInsertAtTheCursorWhenTheCursorIsInsideTheName', () => {
    expect(editHarnessName({ value: 'newharness', cursor: 3 }, ' -', {})).toEqual({
      value: 'new-harness',
      cursor: 4,
      notice: `Removed space. ${allowedCharacters}`,
    })
  })

  it('shouldCutTheInputAtTheLimitWhenTheNameWouldBeTooLong', () => {
    const field = atEnd('a'.repeat(60))

    const edited = editHarnessName(field, 'bcdefgh', {})

    expect(edited).toEqual({ ...atEnd(`${'a'.repeat(60)}bcde`), notice: 'A name can have at most 64 characters.' })
  })

  it.each([
    ['left', { leftArrow: true }, '', 2, { value: 'name', cursor: 1 }],
    ['right', { rightArrow: true }, '', 1, { value: 'name', cursor: 2 }],
    ['backspace', { backspace: true }, '', 2, { value: 'nme', cursor: 1 }],
    ['delete character', {}, '\u007f', 2, { value: 'nme', cursor: 1 }],
    ['control U', { ctrl: true }, 'u', 2, { value: 'me', cursor: 0 }],
  ])('shouldEditWithoutANoticeWhenTheKeyIs %s', (_case, key, input, cursor, expected) => {
    const field = { value: 'name', cursor, notice: `Removed space. ${allowedCharacters}` }

    expect(editHarnessName(field, input, key)).toEqual(expected)
  })
})

describe('harnessNameProblem', () => {
  it.each([
    ['', 'Enter a name.'],
    ['.', 'Enter a name other than "." or "..".'],
    ['..', 'Enter a name other than "." or "..".'],
  ])('shouldSayWhatTheNameNeedsWhenTheNameIs %j', (name, problem) => {
    expect(harnessNameProblem(name)).toBe(problem)
  })

  it.each(['new-harness', '.hidden', 'a..b'])('shouldAcceptTheNameWhenItHasAllowedCharacters %s', (name) => {
    expect(harnessNameProblem(name)).toBeUndefined()
  })
})

describe('HARNESS_NAME_RULE', () => {
  it('shouldNameTheAllowedCharactersAndTheLimitWhenTheFormShowsIt', () => {
    expect(HARNESS_NAME_RULE).toBe(`${allowedCharacters} Up to 64 characters.`)
  })
})
