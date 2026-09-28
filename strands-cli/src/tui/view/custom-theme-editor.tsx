import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useInput, type DOMElement } from 'ink'

import {
  FROG_THEMES,
  FROG_THEME_LABELS,
  THEME_COLOR_KEYS,
  type ChatSettings,
  type ResolvedColorMode,
} from '../chat/types.js'
import { parseMouseInput } from '../terminal/mouse-input.js'
import { elementAtMouse, registerElement } from './interaction.js'
import { Box, getTheme, Text, ThemeProvider } from './theme.js'
import { FadeIn } from './fade-in.js'

export type Appearance = Pick<ChatSettings, 'frogTheme' | 'colorMode' | 'customTheme'>

type ColorKey = (typeof THEME_COLOR_KEYS)[number]
const EDITABLE_COLOR_KEYS = THEME_COLOR_KEYS.filter((key) => key !== 'border')
type Focus = 'base' | 'mode' | 'role' | 'neutrals' | 'palette' | 'reset-color' | 'reset-mode' | 'apply' | 'cancel'
type Target =
  | 'base:previous'
  | 'base:next'
  | 'mode:light'
  | 'mode:dark'
  | 'role:previous'
  | 'role:next'
  | 'reset-color'
  | 'reset-mode'
  | 'apply'
  | 'cancel'
  | `neutral:${number}`
  | `color:${number}`

const COLOR_LABELS: Record<ColorKey, string> = {
  background: 'Canvas',
  foreground: 'Main text',
  muted: 'Quiet text',
  surface: 'Buttons',
  panel: 'Panels',
  selection: 'Selection',
  border: 'Borders',
  accent: 'Accent',
  hover: 'Hover',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
  frog: 'Frog',
}

const NEUTRALS = ['#ffffff', '#e5e7eb', '#a3a3a3', '#737373', '#404040', '#262626', '#171717', '#000000']
const COLOR_ROWS = [
  { saturation: 45, lightness: 88 },
  { saturation: 70, lightness: 70 },
  { saturation: 78, lightness: 52 },
  { saturation: 68, lightness: 32 },
]
const FOCUS_ORDER: Focus[] = [
  'base',
  'mode',
  'role',
  'neutrals',
  'palette',
  'reset-color',
  'reset-mode',
  'apply',
  'cancel',
]

export function CustomThemeEditor({
  settings,
  animate = false,
  width,
  height,
  onPreview,
  onApply,
  onClose,
}: {
  settings: Appearance
  animate?: boolean
  width: number
  height: number
  onPreview(settings: Appearance): void
  onApply(settings: Appearance): Promise<void> | void
  onClose(): void
}): ReactElement {
  const [draft, setDraft] = useState(() => globalThis.structuredClone(settings))
  const [mode, setMode] = useState<ResolvedColorMode>(() => getTheme(settings).mode)
  const [roleIndex, setRoleIndex] = useState(() => EDITABLE_COLOR_KEYS.indexOf('accent'))
  const [focus, setFocus] = useState<Focus>('palette')
  const [neutralIndex, setNeutralIndex] = useState(0)
  const [colorIndex, setColorIndex] = useState(0)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [hovered, setHovered] = useState<Target>()
  const elements = useRef(new Map<Target, DOMElement>())
  const pressed = useRef<Target | undefined>(undefined)
  const panelWidth = Math.max(1, Math.min(width - 2, 82))
  const compact = panelWidth < 56
  const compactHeight = height < 24
  const paletteColumns = compact ? 10 : 12
  const paletteRowCount = compactHeight ? (height < 20 ? 2 : 3) : COLOR_ROWS.length
  const colorsInPalette = useMemo(
    () =>
      COLOR_ROWS.slice(-paletteRowCount).flatMap(({ saturation, lightness }) =>
        Array.from({ length: paletteColumns }, (_, index) =>
          hslToHex((index * 360) / paletteColumns, saturation, lightness)
        )
      ),
    [paletteColumns, paletteRowCount]
  )
  const presets = FROG_THEMES.filter((theme) => theme !== 'custom')
  const selectedRole = EDITABLE_COLOR_KEYS[roleIndex]!
  const visibleSettings = { ...draft, frogTheme: 'custom' as const, colorMode: mode }
  const colors = getTheme(visibleSettings)
  const selectedColor = colors[selectedRole]
  const customized = draft.customTheme[mode][selectedRole] !== undefined

  useEffect(() => {
    onPreview({ ...draft, frogTheme: 'custom', colorMode: mode })
  }, [draft, mode, onPreview])

  useEffect(() => {
    setNeutralIndex(closestColor(NEUTRALS, selectedColor))
    setColorIndex(closestColor(colorsInPalette, selectedColor))
  }, [colorsInPalette, selectedColor])

  function changeBase(direction: -1 | 1): void {
    const current = presets.indexOf(draft.customTheme.base)
    const base = presets[(current + direction + presets.length) % presets.length]!
    setDraft((value) => ({ ...value, customTheme: { ...value.customTheme, base } }))
  }

  function changeRole(direction: -1 | 1): void {
    setRoleIndex((current) => (current + direction + EDITABLE_COLOR_KEYS.length) % EDITABLE_COLOR_KEYS.length)
  }

  function setRoleColor(color: string): void {
    setDraft((value) => ({
      ...value,
      customTheme: {
        ...value.customTheme,
        [mode]: { ...value.customTheme[mode], [selectedRole]: color },
      },
    }))
    setError(undefined)
  }

  function resetColor(): void {
    setDraft((value) => {
      const variant = { ...value.customTheme[mode] }
      delete variant[selectedRole]
      return { ...value, customTheme: { ...value.customTheme, [mode]: variant } }
    })
    setError(undefined)
  }

  function resetMode(): void {
    setDraft((value) => ({ ...value, customTheme: { ...value.customTheme, [mode]: {} } }))
    setError(undefined)
  }

  async function apply(): Promise<void> {
    setSaving(true)
    try {
      await onApply({ ...draft, frogTheme: 'custom' })
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  function chooseNeutral(index: number): void {
    const next = Math.max(0, Math.min(NEUTRALS.length - 1, index))
    setNeutralIndex(next)
    setRoleColor(NEUTRALS[next]!)
  }

  function chooseColor(index: number): void {
    const next = Math.max(0, Math.min(colorsInPalette.length - 1, index))
    setColorIndex(next)
    setRoleColor(colorsInPalette[next]!)
  }

  function activate(target: Target): void {
    if (target === 'base:previous') changeBase(-1)
    else if (target === 'base:next') changeBase(1)
    else if (target === 'mode:light') setMode('light')
    else if (target === 'mode:dark') setMode('dark')
    else if (target === 'role:previous') changeRole(-1)
    else if (target === 'role:next') changeRole(1)
    else if (target === 'reset-color') resetColor()
    else if (target === 'reset-mode') resetMode()
    else if (target === 'apply') void apply()
    else if (target === 'cancel') onClose()
    else if (target.startsWith('neutral:')) chooseNeutral(Number(target.slice('neutral:'.length)))
    else chooseColor(Number(target.slice('color:'.length)))
  }

  function activateFocus(): void {
    if (focus === 'base') changeBase(1)
    else if (focus === 'mode') setMode(mode === 'light' ? 'dark' : 'light')
    else if (focus === 'role') changeRole(1)
    else if (focus === 'neutrals') chooseNeutral(neutralIndex)
    else if (focus === 'palette') chooseColor(colorIndex)
    else if (focus === 'reset-color') resetColor()
    else if (focus === 'reset-mode') resetMode()
    else if (focus === 'apply') void apply()
    else onClose()
  }

  function focusForTarget(target: Target): Focus {
    if (target.startsWith('base:')) return 'base'
    if (target.startsWith('mode:')) return 'mode'
    if (target.startsWith('role:')) return 'role'
    if (target.startsWith('neutral:')) return 'neutrals'
    if (target.startsWith('color:')) return 'palette'
    return target as Focus
  }

  useInput((input, key) => {
    if (saving) return
    if (key.escape) {
      onClose()
      return
    }
    const mouse = parseMouseInput(input)
    if (mouse) {
      const target = elementAtMouse(elements.current, mouse)
      if (mouse.action === 'move') {
        setHovered(target)
      } else if (mouse.action === 'press' && (mouse.button & 3) === 0) {
        pressed.current = elementAtMouse(elements.current, mouse)
      } else if (mouse.action === 'release') {
        const pressedTarget = pressed.current
        pressed.current = undefined
        if (target && target === pressedTarget) {
          setFocus(focusForTarget(target))
          activate(target)
        }
      }
      return
    }
    setHovered(undefined)
    if (key.tab) {
      const current = FOCUS_ORDER.indexOf(focus)
      setFocus(FOCUS_ORDER[(current + (key.shift ? -1 : 1) + FOCUS_ORDER.length) % FOCUS_ORDER.length]!)
      return
    }
    if (focus === 'base' && (key.leftArrow || key.rightArrow)) {
      changeBase(key.leftArrow ? -1 : 1)
    } else if (focus === 'mode' && (key.leftArrow || key.rightArrow)) {
      setMode(key.leftArrow ? 'light' : 'dark')
    } else if (focus === 'role' && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)) {
      changeRole(key.leftArrow || key.upArrow ? -1 : 1)
    } else if (focus === 'neutrals' && (key.leftArrow || key.rightArrow)) {
      chooseNeutral(neutralIndex + (key.leftArrow ? -1 : 1))
    } else if (focus === 'palette' && (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow)) {
      const change = key.leftArrow ? -1 : key.rightArrow ? 1 : key.upArrow ? -paletteColumns : paletteColumns
      chooseColor(colorIndex + change)
    } else if (key.return || input === ' ') {
      activateFocus()
    }
  })

  const swatch = (color: string, target: Target, active: boolean): ReactElement => (
    <Box
      key={target}
      ref={(element) => registerElement(elements.current, target, element)}
      width={3}
      height={1}
      backgroundColor={color}
      justifyContent="center"
    >
      <Text color={contrastColor(color)}>{active ? '◆' : hovered === target ? '◇' : ' '}</Text>
    </Box>
  )

  const action = (
    target: Extract<Target, 'reset-color' | 'reset-mode' | 'apply' | 'cancel'>,
    label: string
  ): ReactElement => (
    <Box
      ref={(element) => registerElement(elements.current, target, element)}
      paddingX={1}
      backgroundColor={
        hovered === target
          ? colors.selection
          : target === 'apply'
            ? colors.accent
            : focus === target
              ? colors.selection
              : colors.surface
      }
    >
      <Text
        bold={target === 'apply'}
        color={hovered === target ? colors.accent : target === 'apply' ? colors.panel : colors.foreground}
      >
        {label}
      </Text>
    </Box>
  )

  return (
    <ThemeProvider settings={visibleSettings}>
      <FadeIn animate={animate} background={colors.background}>
        <Box
          position="absolute"
          width={width}
          height={height}
          alignItems="center"
          justifyContent="center"
          backgroundColor={colors.background}
        >
          <Box width={panelWidth} paddingX={1} flexDirection="column" backgroundColor={colors.panel}>
            <Box justifyContent="space-between">
              <Text bold color={colors.accent}>
                Customize theme ✦
              </Text>
              <Text dimColor>{customized ? 'Custom color' : 'From base'}</Text>
            </Box>
            {!compactHeight ? <Text dimColor>Editing {mode} colors · pick a role, then a swatch</Text> : null}

            {!compactHeight ? (
              <Box marginTop={1} height={3} paddingX={1} alignItems="center" backgroundColor={colors.background}>
                <Box width={12} flexShrink={0} justifyContent="center">
                  <Text bold color={colors.frog}>
                    ╭( ◉‿◉ )╮
                  </Text>
                </Box>
                <Box flexDirection="column" overflow="hidden">
                  <Text color={colors.foreground} wrap="truncate-end">
                    <Text bold color={colors.accent}>
                      ◆ Strands
                    </Text>{' '}
                    Your theme, live
                  </Text>
                  <Text wrap="truncate-end">
                    <Text color={colors.success}>✓ Ready</Text>
                    <Text color={colors.muted}> · </Text>
                    <Text color={colors.warning}>● Thinking</Text>
                    <Text color={colors.muted}> · </Text>
                    <Text color={colors.error}>● Error</Text>
                  </Text>
                </Box>
              </Box>
            ) : null}

            <Box marginTop={1} justifyContent="space-between">
              <Box>
                <Text dimColor>Base </Text>
                <Box
                  ref={(element) => registerElement(elements.current, 'base:previous', element)}
                  paddingX={1}
                  backgroundColor={hovered === 'base:previous' || focus === 'base' ? colors.selection : colors.surface}
                >
                  <Text color={hovered === 'base:previous' ? colors.accent : colors.foreground}>‹</Text>
                </Box>
                <Box width={10} justifyContent="center" backgroundColor={colors.surface}>
                  <Text bold={focus === 'base'} wrap="truncate-end">
                    {FROG_THEME_LABELS[draft.customTheme.base]}
                  </Text>
                </Box>
                <Box
                  ref={(element) => registerElement(elements.current, 'base:next', element)}
                  paddingX={1}
                  backgroundColor={hovered === 'base:next' || focus === 'base' ? colors.selection : colors.surface}
                >
                  <Text color={hovered === 'base:next' ? colors.accent : colors.foreground}>›</Text>
                </Box>
              </Box>
              <Box>
                {(['light', 'dark'] as const).map((candidate) => (
                  <Box
                    key={candidate}
                    ref={(element) => registerElement(elements.current, `mode:${candidate}`, element)}
                    paddingX={1}
                    backgroundColor={
                      hovered === `mode:${candidate}`
                        ? colors.selection
                        : candidate === mode
                          ? colors.accent
                          : colors.surface
                    }
                  >
                    <Text
                      bold={candidate === mode}
                      color={
                        hovered === `mode:${candidate}`
                          ? colors.accent
                          : candidate === mode
                            ? colors.panel
                            : colors.foreground
                      }
                    >
                      {candidate[0]!.toUpperCase() + candidate.slice(1)}
                    </Text>
                  </Box>
                ))}
              </Box>
            </Box>

            <Box marginTop={1} alignItems="center">
              <Text dimColor>Color </Text>
              <Box
                ref={(element) => registerElement(elements.current, 'role:previous', element)}
                paddingX={1}
                backgroundColor={hovered === 'role:previous' || focus === 'role' ? colors.selection : colors.surface}
              >
                <Text color={hovered === 'role:previous' ? colors.accent : colors.foreground}>‹</Text>
              </Box>
              <Box width={compact ? 14 : 16} justifyContent="center" backgroundColor={colors.surface}>
                <Text bold color={focus === 'role' ? colors.accent : colors.foreground}>
                  {COLOR_LABELS[selectedRole]}
                </Text>
              </Box>
              <Box
                ref={(element) => registerElement(elements.current, 'role:next', element)}
                paddingX={1}
                backgroundColor={hovered === 'role:next' || focus === 'role' ? colors.selection : colors.surface}
              >
                <Text color={hovered === 'role:next' ? colors.accent : colors.foreground}>›</Text>
              </Box>
              {!compact ? (
                <>
                  <Box marginLeft={1} width={3} backgroundColor={selectedColor} />
                  <Text dimColor> {selectedColor}</Text>
                </>
              ) : null}
            </Box>
            {compact ? (
              <Box>
                <Box width={3} backgroundColor={selectedColor} />
                <Text dimColor>
                  {' '}
                  {selectedColor} · {roleIndex + 1}/{EDITABLE_COLOR_KEYS.length}
                </Text>
              </Box>
            ) : null}

            {!compactHeight ? <Text dimColor>Neutrals</Text> : null}
            <Box>
              {NEUTRALS.map((color, index) =>
                swatch(color, `neutral:${index}`, focus === 'neutrals' && index === neutralIndex)
              )}
            </Box>
            {!compactHeight ? <Text dimColor>Color field</Text> : null}
            <Box width={paletteColumns * 3} flexWrap="wrap">
              {colorsInPalette.map((color, index) =>
                swatch(color, `color:${index}`, focus === 'palette' && index === colorIndex)
              )}
            </Box>

            {compact ? (
              <Box marginTop={1} flexDirection="column" alignItems="center">
                <Box>
                  {action('reset-color', 'Reset color')}
                  {action('reset-mode', `Reset ${mode}`)}
                </Box>
                <Box>
                  {action('apply', 'Apply theme')}
                  {action('cancel', 'Cancel')}
                </Box>
              </Box>
            ) : (
              <Box marginTop={1} justifyContent="center">
                {action('reset-color', 'Reset color')}
                {action('reset-mode', `Reset ${mode}`)}
                {action('apply', 'Apply theme')}
                {action('cancel', 'Cancel')}
              </Box>
            )}
            <Text color={error ? colors.error : colors.muted} wrap="truncate-end">
              {error ?? (saving ? 'Applying…' : 'Tab sections · arrows explore · Enter or click choose · Esc cancel')}
            </Text>
          </Box>
        </Box>
      </FadeIn>
    </ThemeProvider>
  )
}

function hslToHex(hue: number, saturation: number, lightness: number): string {
  const saturationRatio = saturation / 100
  const lightnessRatio = lightness / 100
  const chroma = (1 - Math.abs(2 * lightnessRatio - 1)) * saturationRatio
  const segment = hue / 60
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1))
  const [red, green, blue] =
    segment < 1
      ? [chroma, secondary, 0]
      : segment < 2
        ? [secondary, chroma, 0]
        : segment < 3
          ? [0, chroma, secondary]
          : segment < 4
            ? [0, secondary, chroma]
            : segment < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary]
  const offset = lightnessRatio - chroma / 2
  return `#${[red, green, blue]
    .map((channel) =>
      Math.round((channel + offset) * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

function closestColor(palette: readonly string[], color: string): number {
  const target = rgb(color)
  let closest = 0
  let distance = Number.POSITIVE_INFINITY
  for (const [index, candidate] of palette.entries()) {
    const value = rgb(candidate)
    const next = value.reduce((total, channel, channelIndex) => total + (channel - target[channelIndex]!) ** 2, 0)
    if (next < distance) {
      closest = index
      distance = next
    }
  }
  return closest
}

function contrastColor(color: string): string {
  const [red, green, blue] = rgb(color)
  return (red * 299 + green * 587 + blue * 114) / 1000 > 145 ? '#101213' : '#ffffff'
}

function rgb(color: string): [number, number, number] {
  return [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16)) as [number, number, number]
}
