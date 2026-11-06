import { createElement, useState, type ReactElement } from 'react'
import { Box, Text, render, useInput } from 'ink'
import { sanitizeTerminalText } from '../terminal/text.js'
import type { DiscoveredHarness } from './search.js'

export type HarnessChoice =
  | { kind: 'cli' }
  | { kind: 'discovered'; harness: DiscoveredHarness }
  | { kind: 'create'; language: 'typescript' | 'python'; name: string }

interface PickerProps {
  cliName: string
  harnesses: readonly DiscoveredHarness[]
  onSelect: (selection: HarnessChoice | undefined) => void
}

export const HarnessPicker = ({ cliName, harnesses, onSelect }: PickerProps): ReactElement => {
  const [selection, setSelection] = useState(0)
  const [creating, setCreating] = useState(false)
  const [language, setLanguage] = useState<'typescript' | 'python'>('typescript')
  const [name, setName] = useState('new-harness')
  const rows = [
    { label: `Strands CLI · ${sanitizeTerminalText(cliName)}`, detail: 'Create or open an independent local copy' },
    ...harnesses.map((harness) => ({
      label: `${sanitizeTerminalText(harness.name)} · ${harness.language}`,
      detail: sanitizeTerminalText(harness.entrypoint),
    })),
    { label: 'Create a new harness', detail: 'Start from your saved profile' },
  ]
  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) return onSelect(undefined)
    if (creating) {
      if (key.tab) return setLanguage((current) => (current === 'typescript' ? 'python' : 'typescript'))
      if (key.return && name && name !== '.' && name !== '..') return onSelect({ kind: 'create', name, language })
      if (key.backspace || key.delete) return setName((current) => current.slice(0, -1))
      if (!key.ctrl && !key.meta && /^[a-zA-Z0-9._-]+$/.test(input))
        setName((current) => `${current}${input}`.slice(0, 64))
      return
    }
    if (key.upArrow) setSelection((current) => (current + rows.length - 1) % rows.length)
    if (key.downArrow) setSelection((current) => (current + 1) % rows.length)
    if (!key.return) return
    if (selection === 0) return onSelect({ kind: 'cli' })
    const harness = harnesses[selection - 1]
    if (harness) return onSelect({ kind: 'discovered', harness })
    setCreating(true)
  })
  if (creating) {
    return (
      <Box flexDirection="column">
        <Text bold>Create a harness</Text>
        <Text>Name: {name}▏</Text>
        <Text>Language: {language}</Text>
        <Text dimColor>Tab language · Enter create · Esc cancel</Text>
      </Box>
    )
  }
  const start = Math.max(0, selection - 5)
  return (
    <Box flexDirection="column">
      <Text bold>strands dev · Select a harness</Text>
      {rows.slice(start, start + 10).map((row, index) => (
        <Box key={start + index} flexDirection="column">
          <Text bold={start + index === selection} {...(start + index === selection ? { color: 'cyan' } : {})}>
            {start + index === selection ? '›' : ' '} {row.label}
          </Text>
          <Text dimColor> {row.detail}</Text>
        </Box>
      ))}
      <Text dimColor>↑↓ select · Enter open · Esc cancel</Text>
    </Box>
  )
}

export const chooseHarness = async (options: Omit<PickerProps, 'onSelect'>): Promise<HarnessChoice | undefined> => {
  let complete: (selection: HarnessChoice | undefined) => void = () => undefined
  const result = new Promise<HarnessChoice | undefined>((resolve) => {
    complete = resolve
  })
  const instance = render(createElement(HarnessPicker, { ...options, onSelect: complete }), { exitOnCtrlC: false })
  try {
    return await result
  } finally {
    instance.unmount()
    await instance.waitUntilExit()
    instance.cleanup()
  }
}
