import { createElement } from 'react'
import { Box } from 'ink'
import { describe, expect, it, vi } from 'vitest'
import { HarnessPicker } from '../../src/dev/picker.js'
import { captureFrame, render, ttyInput, ttyOutput } from '../fixtures/terminal.js'

const harness = {
  name: 'Project harness',
  entrypoint: '/project/agent.py',
  root: '/project',
  language: 'python' as const,
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
          cli: { name: 'Saved profile', path: '/home/test/.strands/cli.toml' },
          workspace: '/work/base-cli',
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
    const output = ttyOutput(60, 20)
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
        workspace: '/work/strands-dev',
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
    expect(text()).toContain('Workspace folder: /work/strands-dev')
    expect(text()).toContain('Project harness')
    expect(selected).not.toHaveBeenCalled()
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'discovered', harness }, '/work/strands-dev'))
  })

  it('shouldSubmitTheEditedFolderWhenTheUserChangesIt', async () => {
    const { input, text, selected } = withFolder()
    await vi.waitFor(() => expect(text()).toContain('Select a harness'))
    input.write('\r')
    await vi.waitFor(() => expect(text()).toContain('Workspace folder: /work/strands-dev'))

    for (const _ of 'dev') input.write('\u001b[D')
    input.write('my-')
    await vi.waitFor(() => expect(text()).toContain('/work/strands-my-dev'))
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenCalledWith({ kind: 'cli' }, '/work/strands-my-dev'))
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
    await vi.waitFor(() => expect(text()).toContain('Workspace folder: /work/strands-dev'))

    input.write('\u0015')
    await vi.waitFor(() => expect(text()).not.toContain('/work/strands-dev'))
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
        workspace: '/work/strands-dev',
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

    input.write('-2')
    await vi.waitFor(() => expect(frame().join('\n')).toContain('/work/strands-dev-2'))
    input.write('\r')

    await vi.waitFor(() => expect(selected).toHaveBeenLastCalledWith({ kind: 'cli' }, '/work/strands-dev-2'))
    expect(selected).toHaveBeenCalledTimes(2)
  })
})
