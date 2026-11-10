import type { ReactElement } from 'react'
import type { DOMElement } from 'ink'

import type { ChatPanel, ChatPanelRow, ChatSettings, SettingsCategory } from '../../chat/types.js'
import { SETTINGS_CATEGORIES } from '../../settings.js'
import { panelControlTarget, parsePanelControlTarget } from '../interaction.js'
import { SettingsPanel } from '../settings-panel.js'
import type { WizardRow } from './types.js'

export type SetupSettingsChoiceTarget = `choice:${number}:${number}` | `category:${SettingsCategory}`

export function SetupSettingsPanel({
  rows,
  category,
  settings,
  start,
  selected,
  width,
  height,
  hoveredControl,
  onRowElement,
  onChoiceElement,
}: {
  rows: readonly WizardRow[]
  category: SettingsCategory
  settings: ChatSettings
  start: number
  selected: number
  width: number
  height: number
  hoveredControl?: string
  onRowElement(index: number, element: DOMElement | null): void
  onChoiceElement(target: SetupSettingsChoiceTarget, element: DOMElement | null): void
}): ReactElement {
  const panelRows = rows.map(setupPanelRow)
  const panel: ChatPanel = {
    id: `setup-settings-${category}`,
    kind: 'settings',
    title: category,
    rows: panelRows,
    settingsCategories: SETTINGS_CATEGORIES,
    settingsCategory: category,
  }
  const hoveredTarget = setupHoveredTarget(hoveredControl, rows, start)
  return (
    <SettingsPanel
      embedded
      panel={panel}
      rows={panelRows}
      selected={selected}
      start={start}
      width={width}
      height={height}
      appearance={settings}
      {...(hoveredTarget ? { hoveredControl: hoveredTarget } : {})}
      {...(hoveredControl?.startsWith('category:') ? { hoveredFilter: `settings:${hoveredControl.slice(9)}` } : {})}
      onRowElement={onRowElement}
      onControlElement={(target, element) => {
        const parsed = parsePanelControlTarget(target)
        const rowIndex = parsed?.index
        const row = rowIndex === undefined ? undefined : rows[rowIndex - start]
        const choiceIndex = row?.choices ? setupChoiceIndex(target, row.choices) : -1
        if (rowIndex !== undefined && choiceIndex >= 0) {
          onChoiceElement(`choice:${rowIndex}:${choiceIndex}`, element)
        }
      }}
      onFilterElement={(target, element) => {
        const nextCategory = target.slice('settings:'.length) as SettingsCategory
        onChoiceElement(`category:${nextCategory}`, element)
      }}
    />
  )
}

function setupHoveredTarget(
  hoveredControl: string | undefined,
  rows: readonly WizardRow[],
  start: number
): string | undefined {
  const match = /^choice:(\d+):(\d+)$/u.exec(hoveredControl ?? '')
  if (!match) {
    return undefined
  }
  const rowIndex = Number(match[1])
  const choices = rows[rowIndex - start]?.choices
  if (!choices) {
    return undefined
  }
  if (choices.every(({ value }) => typeof value === 'boolean')) {
    return panelControlTarget(rowIndex, 'toggle')
  }
  const value = choices[Number(match[2])]?.value
  return value === undefined ? undefined : panelControlTarget(rowIndex, String(value))
}

function setupChoiceIndex(target: string, choices: NonNullable<WizardRow['choices']>): number {
  if (choices.every(({ value }) => typeof value === 'boolean')) {
    return choices.findIndex(({ active }) => !active)
  }
  const value = parsePanelControlTarget(target)?.value
  return choices.findIndex((choice) => String(choice.value) === value)
}

function setupPanelRow(row: WizardRow): ChatPanelRow {
  const choices = row.choices
  return {
    label: row.label,
    description: row.description,
    value: row.id,
    ...(choices
      ? {
          control: choices.every(({ value }) => typeof value === 'boolean')
            ? { kind: 'toggle' as const, checked: choices.some(({ value, active }) => value === true && active) }
            : {
                kind: 'segmented' as const,
                options: choices.map(({ label, value, active }) => ({
                  label,
                  value: String(value),
                  ...(active ? { active: true } : {}),
                })),
              },
        }
      : {}),
  }
}
