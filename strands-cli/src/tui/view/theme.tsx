import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from 'react'
import { Box as InkBox, Text as InkText } from 'ink'

import {
  DEFAULT_CHAT_SETTINGS,
  type FrogTheme,
  type ResolvedColorMode,
  type ThemeSettings,
  type ThemeColors,
} from '../chat/types.js'
import { currentCanvasColor, currentColorMode, subscribeColorMode } from './theme-detection.js'
import { useFadeAnsi, useFadeColor } from './fade-in.js'

// `canvas` is the terminal's reported background color; the palette background stands in when the terminal does not report one.
export type Theme = ThemeColors & { mode: ResolvedColorMode; canvas: string }

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
    diffAdd: '#173a22',
    diffRemove: '#46202a',
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
    diffAdd: '#dcf5e2',
    diffRemove: '#fbe1e3',
  },
} satisfies Record<ResolvedColorMode, Omit<ThemeColors, 'accent'>>

const ACCENTS = {
  green: { light: '#007439', dark: '#00cc60' },
  minimal: { light: '#35424a', dark: '#d2d9dd' },
  homeland: { light: '#006581', dark: '#5ad3f4' },
  merlin: { light: '#5d3a97', dark: '#ad95e8' },
  kikker: { light: '#934600', dark: '#ff9d3d' },
  oak: { light: '#754322', dark: '#d0a071' },
  spectre: { light: '#535d6b', dark: '#a5aebc' },
  scarlet: { light: '#a51f38', dark: '#ff7888' },
} satisfies Record<FrogTheme, Record<ResolvedColorMode, string>>

export function getTheme(settings: ThemeSettings, detectedMode?: ResolvedColorMode, canvas?: string): Theme {
  const mode = detectedMode ?? currentColorMode()
  // A supplied mode renders a preview, not the live terminal, so the detected canvas does not apply.
  const detectedCanvas = detectedMode === undefined ? currentCanvasColor() : undefined
  return {
    ...BASE_COLORS[mode],
    accent: ACCENTS[settings.frogTheme][mode],
    canvas: canvas ?? detectedCanvas ?? BASE_COLORS[mode].background,
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
  const terminalMode = useSyncExternalStore(subscribeColorMode, currentColorMode, currentColorMode)
  const terminalCanvas = useSyncExternalStore(subscribeColorMode, currentCanvasColor, currentCanvasColor)
  const mode = detectedMode ?? terminalMode
  const canvas = detectedMode === undefined ? terminalCanvas : undefined
  const theme = useMemo(() => getTheme(settings, mode, canvas), [settings.frogTheme, mode, canvas])
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
  const fadedText = useFadeAnsi(typeof children === 'string' ? children : '')
  return (
    <InkText
      {...props}
      {...(fadedForeground ? { color: fadedForeground } : {})}
      {...(fadedBackground ? { backgroundColor: fadedBackground } : {})}
    >
      <TextStyleContext value={{ backgroundColor: background }}>
        {typeof children === 'string' ? fadedText : children}
      </TextStyleContext>
    </InkText>
  )
}

export function Box({ backgroundColor, borderColor, ...props }: ComponentProps<typeof InkBox>): ReactElement {
  const background = useFadeColor(backgroundColor)
  const border = useFadeColor(borderColor)
  return <InkBox {...props} backgroundColor={background} borderColor={border} />
}

export const STRANDS_GREEN = DEFAULT_THEME.accent
