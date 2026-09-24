import { createContext, useContext, useMemo, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { Box as InkBox, Text as InkText } from 'ink'

import {
  DEFAULT_CHAT_SETTINGS,
  type ChatSettings,
  type FrogTheme,
  type ResolvedColorMode,
  type ThemeColors,
} from '../chat/types.js'
import { detectColorMode } from './theme-detection.js'
import { useFadeColor } from './fade-in.js'

export { detectColorMode } from './theme-detection.js'

export type Theme = ThemeColors & { mode: ResolvedColorMode }
type ThemeSettings = Pick<ChatSettings, 'frogTheme' | 'colorMode' | 'customTheme'>

const BASE_COLORS = {
  dark: {
    background: '#101213',
    foreground: '#eceff1',
    muted: '#a2a9ad',
    surface: '#202223',
    panel: '#181a1b',
    selection: '#303233',
    border: '#646c71',
    hover: '#c084fc',
    success: '#68f58a',
    warning: '#ffb454',
    error: '#ff727c',
  },
  light: {
    background: '#ffffff',
    foreground: '#202629',
    muted: '#566168',
    surface: '#f0f3f4',
    panel: '#f7f9fa',
    selection: '#dce3e7',
    border: '#727e85',
    hover: '#7036a8',
    success: '#166534',
    warning: '#854400',
    error: '#b42332',
  },
} satisfies Record<ResolvedColorMode, Omit<ThemeColors, 'accent' | 'frog'>>

const ACCENTS = {
  green: { light: '#166534', dark: '#68f58a' },
  minimal: { light: '#35424a', dark: '#d2d9dd' },
  homeland: { light: '#006581', dark: '#5ad3f4' },
  merlin: { light: '#7036a8', dark: '#c49bff' },
  kikker: { light: '#934600', dark: '#ff9d3d' },
  circuit: { light: '#234e96', dark: '#79aaff' },
  spectre: { light: '#a71935', dark: '#ff6b82' },
  solar: { light: '#805400', dark: '#ffd166' },
} satisfies Record<Exclude<FrogTheme, 'custom'>, Record<ResolvedColorMode, string>>

const FROG_COLORS = {
  green: { light: '#5ab36e', dark: '#81ff9d' },
  minimal: { light: '#1c1e22', dark: '#ededed' },
  homeland: { light: '#5a9e64', dark: '#80e28f' },
  merlin: { light: '#865cb0', dark: '#c084fc' },
  kikker: { light: '#b35900', dark: '#ff7f00' },
  circuit: { light: '#7a7f86', dark: '#aeb6bf' },
  spectre: { light: '#111317', dark: '#181b21' },
  solar: { light: '#b77900', dark: '#ffd166' },
} satisfies Record<Exclude<FrogTheme, 'custom'>, Record<ResolvedColorMode, string>>

export function getTheme(settings: ThemeSettings, detectedMode?: ResolvedColorMode): Theme {
  const mode = settings.colorMode === 'auto' ? (detectedMode ?? detectColorMode()) : settings.colorMode
  const base = settings.frogTheme === 'custom' ? settings.customTheme.base : settings.frogTheme
  return {
    ...BASE_COLORS[mode],
    accent: ACCENTS[base][mode],
    frog: FROG_COLORS[base][mode],
    ...(settings.frogTheme === 'custom' ? settings.customTheme[mode] : {}),
    mode,
  }
}

const DEFAULT_THEME = getTheme(DEFAULT_CHAT_SETTINGS, 'dark')
const ThemeContext = createContext<Theme>(DEFAULT_THEME)
const TextStyleContext = createContext<{ backgroundColor: string | undefined } | undefined>(undefined)

export function ThemeProvider({
  settings,
  detectedMode,
  children,
}: {
  settings: ThemeSettings
  detectedMode?: ResolvedColorMode
  children: ReactNode
}): ReactElement {
  const mode = detectedMode ?? detectColorMode()
  const theme = useMemo(
    () => getTheme(settings, mode),
    [settings.frogTheme, settings.colorMode, settings.customTheme, mode]
  )
  return <ThemeContext value={theme}>{children}</ThemeContext>
}

export function useTheme(): Theme {
  return useContext(ThemeContext)
}

const SEMANTIC_COLORS: Readonly<Record<string, keyof ThemeColors>> = {
  black: 'foreground',
  blackBright: 'muted',
  white: 'foreground',
  whiteBright: 'foreground',
  gray: 'muted',
  grey: 'muted',
  red: 'error',
  redBright: 'error',
  green: 'success',
  greenBright: 'success',
  yellow: 'warning',
  yellowBright: 'warning',
  blue: 'accent',
  blueBright: 'accent',
  cyan: 'accent',
  cyanBright: 'accent',
  magenta: 'hover',
  magentaBright: 'hover',
}

export function Text({
  color,
  backgroundColor,
  dimColor,
  children,
  ...props
}: ComponentProps<typeof InkText>): ReactElement {
  const theme = useTheme()
  const parent = useContext(TextStyleContext)
  const semantic = color === undefined ? undefined : SEMANTIC_COLORS[color]
  const foreground = dimColor
    ? theme.muted
    : semantic
      ? theme[semantic]
      : (color ?? (parent ? undefined : theme.foreground))
  const backgroundSemantic = backgroundColor === undefined ? undefined : SEMANTIC_COLORS[backgroundColor]
  const background =
    backgroundColor === 'black'
      ? theme.surface
      : backgroundColor === 'white'
        ? theme.background
        : backgroundColor === 'gray' || backgroundColor === 'grey'
          ? theme.selection
          : backgroundSemantic
            ? theme[backgroundSemantic]
            : (backgroundColor ?? parent?.backgroundColor)
  const fadedForeground = useFadeColor(foreground)
  const fadedBackground = useFadeColor(background)
  return (
    <InkText
      {...props}
      {...(fadedForeground ? { color: fadedForeground } : {})}
      {...(fadedBackground ? { backgroundColor: fadedBackground } : {})}
    >
      <TextStyleContext value={{ backgroundColor: background }}>{children}</TextStyleContext>
    </InkText>
  )
}

export function Box({ backgroundColor, borderColor, ...props }: ComponentProps<typeof InkBox>): ReactElement {
  const background = useFadeColor(backgroundColor)
  const border = useFadeColor(borderColor)
  return <InkBox {...props} backgroundColor={background} borderColor={border} />
}

export const STRANDS_GREEN = DEFAULT_THEME.accent
