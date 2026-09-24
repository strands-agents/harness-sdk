import type { FrogTheme } from '../chat/types.js'

const ESC = '\u001b['

const QUADRANTS: readonly string[] = [' ', '▗', '▖', '▄', '▝', '▐', '▞', '▟', '▘', '▚', '▌', '▙', '▀', '▜', '▛', '█']
const TOP_QUADRANTS = 0b1100

const BASE_PALETTE = {
  white: [235, 255, 241],
  mint: [184, 255, 208],
  lime: [129, 255, 157],
  green: [104, 245, 138],
  emerald: [44, 198, 109],
  forest: [40, 122, 67],
  ink: [7, 28, 17],
  gray: [126, 136, 130],
  dim: [54, 78, 64],
  tongue: [255, 119, 151],
  red: [255, 82, 92],
  orange: [255, 158, 67],
  yellow: [255, 224, 92],
  cyan: [92, 218, 255],
  blue: [82, 139, 255],
  purple: [169, 103, 255],
  pink: [245, 91, 169],
} as const

export type Color = keyof typeof BASE_PALETTE
type Rgb = readonly [number, number, number]
type FrogPalette = Record<Color, Rgb>

export interface FrogRenderOptions {
  colorMode?: 'light' | 'dark'
  frogColor?: string
  customBase?: Exclude<FrogTheme, 'custom'>
}

const FROG_PALETTES = {
  green: BASE_PALETTE,
  minimal: {
    ...BASE_PALETTE,
    white: [250, 250, 250],
    mint: [225, 225, 225],
    lime: [237, 237, 237],
    green: [195, 195, 195],
    emerald: [155, 155, 155],
    forest: [120, 120, 120],
    ink: [237, 237, 237],
    gray: [150, 150, 150],
    dim: [90, 90, 90],
    tongue: [195, 195, 195],
  },
  circuit: {
    ...BASE_PALETTE,
    white: [247, 250, 252],
    mint: [224, 229, 234],
    lime: [174, 182, 191],
    green: [116, 125, 135],
    emerald: [94, 103, 113],
    forest: [65, 72, 81],
    ink: [14, 18, 23],
    gray: [143, 151, 160],
    dim: [76, 84, 94],
    tongue: [255, 54, 72],
    red: [255, 54, 72],
    orange: [237, 78, 91],
    yellow: [255, 202, 207],
    purple: [151, 24, 41],
    pink: [255, 91, 105],
  },
  homeland: {
    white: [235, 249, 255],
    mint: [142, 228, 246],
    lime: [128, 226, 143],
    green: [65, 190, 105],
    emerald: [42, 151, 211],
    forest: [24, 101, 153],
    ink: [4, 24, 43],
    gray: [126, 157, 176],
    dim: [42, 84, 109],
    tongue: [255, 126, 138],
    red: [231, 91, 87],
    orange: [239, 185, 83],
    yellow: [244, 226, 118],
    cyan: [90, 211, 244],
    blue: [34, 125, 206],
    purple: [60, 86, 173],
    pink: [230, 121, 157],
  },
  merlin: {
    ...BASE_PALETTE,
    white: [250, 239, 255],
    mint: [224, 190, 255],
    lime: [192, 132, 252],
    green: [160, 100, 224],
    emerald: [131, 77, 191],
    forest: [98, 59, 142],
    ink: [25, 14, 40],
    gray: [171, 153, 190],
    dim: [91, 68, 120],
    tongue: [241, 163, 234],
    cyan: [203, 179, 255],
    blue: [132, 106, 231],
  },
  kikker: {
    ...BASE_PALETTE,
    white: [255, 247, 232],
    mint: [255, 190, 112],
    lime: [255, 127, 0],
    green: [230, 105, 0],
    emerald: [190, 81, 0],
    forest: [132, 63, 12],
    ink: [32, 17, 5],
    gray: [173, 141, 111],
    dim: [91, 61, 34],
    tongue: [255, 201, 133],
  },
  spectre: {
    ...BASE_PALETTE,
    white: [222, 226, 232],
    mint: [153, 161, 172],
    lime: [0, 0, 0],
    green: [40, 44, 53],
    emerald: [61, 66, 77],
    forest: [79, 85, 97],
    ink: [132, 142, 158],
    gray: [146, 152, 163],
    dim: [78, 83, 95],
    tongue: [255, 55, 76],
    red: [255, 55, 76],
    cyan: [201, 51, 69],
    blue: [136, 30, 47],
  },
  solar: {
    ...BASE_PALETTE,
    white: [255, 250, 225],
    mint: [255, 235, 156],
    lime: [255, 209, 102],
    green: [232, 169, 48],
    emerald: [190, 122, 28],
    forest: [116, 72, 18],
    ink: [42, 27, 5],
    gray: [177, 151, 102],
    dim: [96, 70, 31],
    tongue: [255, 143, 105],
  },
} satisfies Record<Exclude<FrogTheme, 'custom'>, FrogPalette>

const PARTY_COLORS = ['pink', 'yellow', 'cyan', 'purple', 'orange', 'lime', 'blue'] as const
const COLOR_NAMES = Object.keys(BASE_PALETTE) as Color[]
const COLOR_IDS = new Map<Color, number>(COLOR_NAMES.map((name, index) => [name, index]))

export interface Point {
  x: number
  y: number
}

export interface PixelSink {
  setPixel(x: number, y: number, color: Color, priority?: number): void
}

interface VisualCell {
  background: number
  character: string
  foreground: number
}

export class Canvas implements PixelSink {
  private readonly _characters: string[]
  private readonly _cellColors: Int16Array
  private readonly _cellPriorities: Int16Array
  private readonly _pixelColors: Int16Array
  private readonly _pixelPriorities: Int16Array
  private readonly _pixelWidth: number
  private readonly _partyOffset: number
  private readonly _foregroundCodes: readonly string[]
  private readonly _backgroundCodes: readonly string[]
  readonly theme: Exclude<FrogTheme, 'custom'>

  constructor(
    readonly width: number,
    readonly height: number,
    theme: FrogTheme = 'green',
    private readonly _party = false,
    partyElapsedMs = 0,
    options: FrogRenderOptions = {}
  ) {
    const cells = width * height
    this._partyOffset = Math.floor(partyElapsedMs / 80)
    this.theme = _party ? 'green' : theme === 'custom' ? (options.customBase ?? 'green') : theme
    const palette = frogPalette(this.theme, _party ? { colorMode: options.colorMode ?? 'dark' } : options)
    this._foregroundCodes = colorCodes(palette, 38)
    this._backgroundCodes = colorCodes(palette, 48)
    this._pixelWidth = width * 2
    this._characters = new Array<string>(cells).fill(' ')
    this._cellColors = new Int16Array(cells).fill(-1)
    this._cellPriorities = new Int16Array(cells).fill(-1_000)
    this._pixelColors = new Int16Array(cells * 4).fill(-1)
    this._pixelPriorities = new Int16Array(cells * 4).fill(-1_000)
  }

  set(x: number, y: number, character: string, color: Color, priority = 0): void {
    const column = Math.round(x)
    const row = Math.round(y)
    if (column < 0 || column >= this.width || row < 0 || row >= this.height || !character) {
      return
    }
    const index = row * this.width + column
    if (priority < this._cellPriorities[index]!) {
      return
    }
    this._characters[index] = [...character][0] ?? ' '
    this._cellColors[index] = COLOR_IDS.get(this._color(x, y, color))!
    this._cellPriorities[index] = priority
  }

  setPixel(x: number, y: number, color: Color, priority = 0): void {
    const column = Math.round(x * 2)
    const row = Math.round(y)
    if (column < 0 || column >= this._pixelWidth || row < 0 || row >= this.height * 2) {
      return
    }
    const index = row * this._pixelWidth + column
    if (priority < this._pixelPriorities[index]!) {
      return
    }
    this._pixelColors[index] = COLOR_IDS.get(this._color(x, y, color))!
    this._pixelPriorities[index] = priority
  }

  line(from: Point, to: Point, character: string, color: Color, priority = 0): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y))))
    for (let step = 0; step <= steps; step++) {
      const progress = step / steps
      this.set(from.x + (to.x - from.x) * progress, from.y + (to.y - from.y) * progress, character, color, priority)
    }
  }

  rows(color: boolean): string[] {
    const output: string[] = []
    for (let row = 0; row < this.height; row++) {
      output.push(
        renderVisuals(
          Array.from({ length: this.width }, (_, column) => this._visualCell(column, row)),
          color,
          this._foregroundCodes,
          this._backgroundCodes
        )
      )
    }
    return output
  }

  runs(color: boolean): FrogAnimationRun[] {
    const output: FrogAnimationRun[] = []
    for (let row = 0; row < this.height; row++) {
      let start = 0
      let visuals: VisualCell[] = []
      const flush = (): void => {
        if (visuals.length > 0) {
          output.push({
            row,
            column: start,
            text: renderVisuals(visuals, color, this._foregroundCodes, this._backgroundCodes),
          })
          visuals = []
        }
      }
      for (let column = 0; column < this.width; column++) {
        const visual = this._visualCell(column, row)
        if (visual.character === ' ' && visual.background < 0) {
          flush()
        } else {
          if (visuals.length === 0) {
            start = column
          }
          visuals.push(visual)
        }
      }
      flush()
    }
    return output
  }

  private _visualCell(column: number, row: number): VisualCell {
    const cellIndex = row * this.width + column
    const topLeft = row * 2 * this._pixelWidth + column * 2
    const indexes = [topLeft, topLeft + 1, topLeft + this._pixelWidth, topLeft + this._pixelWidth + 1]
    const pixelPriority = Math.max(...indexes.map((index) => this._pixelPriorities[index]!))
    if (this._cellPriorities[cellIndex]! >= pixelPriority) {
      return {
        background: -1,
        character: this._characters[cellIndex]!,
        foreground: this._cellColors[cellIndex]!,
      }
    }

    const colors = indexes.map((index) => this._pixelColors[index]!)
    const opaque = [...new Set(colors.filter((value) => value >= 0))]
    if (opaque.length === 0) {
      return { background: -1, character: ' ', foreground: -1 }
    }
    const foreground = selectPixelColor(opaque, indexes, this._pixelColors, this._pixelPriorities)
    const remainder = opaque.filter((value) => value !== foreground)
    const background =
      colors.some((value) => value < 0) || remainder.length === 0
        ? -1
        : selectPixelColor(remainder, indexes, this._pixelColors, this._pixelPriorities)
    const mask = colors.reduce((value, pixelColor, index) => {
      if (pixelColor === foreground) {
        return value | (1 << (3 - index))
      }
      return value
    }, 0)
    return { background, character: QUADRANTS[mask]!, foreground }
  }

  private _color(x: number, y: number, color: Color): Color {
    if (!this._party || color === 'gray' || color === 'dim') {
      return color
    }
    const index = Math.abs(Math.floor(x / 2) + Math.floor(y / 2) * 3 + this._partyOffset) % PARTY_COLORS.length
    return PARTY_COLORS[index]!
  }
}

function renderVisuals(
  visuals: readonly VisualCell[],
  color: boolean,
  foregroundCodes: readonly string[],
  backgroundCodes: readonly string[]
): string {
  let activeForeground = -2
  let activeBackground = -2
  let rendered = ''
  for (const cell of visuals) {
    const visual = color ? anchorGlyphToBottom(cell) : cell
    if (color) {
      if (visual.foreground !== activeForeground) {
        rendered += visual.foreground >= 0 ? foregroundCodes[visual.foreground] : `${ESC}39m`
        activeForeground = visual.foreground
      }
      if (visual.background !== activeBackground) {
        rendered += visual.background >= 0 ? backgroundCodes[visual.background] : `${ESC}49m`
        activeBackground = visual.background
      }
    }
    rendered += visual.character
  }
  return color ? `${rendered}${ESC}0m` : rendered
}

// Terminal.app's block glyphs stop short of the cell top, so a full block becomes a background-painted space and a
// two-color cell keeps its glyph on the bottom half. Terminals that fill cells exactly render both forms identically.
function anchorGlyphToBottom(visual: VisualCell): VisualCell {
  const mask = QUADRANTS.indexOf(visual.character)
  if (mask < 0 || visual.foreground < 0 || (mask & TOP_QUADRANTS) !== TOP_QUADRANTS) {
    return visual
  }
  if (mask === QUADRANTS.length - 1) {
    return { background: visual.foreground, character: ' ', foreground: visual.foreground }
  }
  if (visual.background < 0) {
    return visual
  }
  return {
    background: visual.foreground,
    character: QUADRANTS[QUADRANTS.length - 1 - mask]!,
    foreground: visual.background,
  }
}

function frogPalette(theme: Exclude<FrogTheme, 'custom'>, options: FrogRenderOptions): FrogPalette {
  const palette: FrogPalette = { ...FROG_PALETTES[theme] }
  if (options.colorMode === 'light') {
    for (const name of COLOR_NAMES) {
      if (name !== 'ink') {
        palette[name] = mixColor(palette[name], [0, 0, 0], 0.3)
      }
    }
    palette.gray = [88, 94, 102]
    palette.dim = [125, 131, 139]
    if (theme === 'minimal') {
      palette.lime = [28, 30, 34]
      palette.ink = palette.lime
    } else if (theme === 'spectre') {
      palette.ink = [17, 19, 25]
    }
  }
  if (options.frogColor && /^#[\da-f]{6}$/i.test(options.frogColor)) {
    const rgb: Rgb = [
      Number.parseInt(options.frogColor.slice(1, 3), 16),
      Number.parseInt(options.frogColor.slice(3, 5), 16),
      Number.parseInt(options.frogColor.slice(5, 7), 16),
    ]
    palette.lime = rgb
    palette.green = mixColor(rgb, [0, 0, 0], 0.18)
    palette.emerald = mixColor(rgb, [0, 0, 0], 0.35)
    palette.forest = mixColor(rgb, [0, 0, 0], 0.5)
    palette.mint = mixColor(rgb, [255, 255, 255], 0.45)
    if (theme === 'minimal') {
      palette.ink = rgb
    }
  }
  return palette
}

function mixColor(from: Rgb, to: Rgb, amount: number): Rgb {
  return [
    Math.round(from[0] + (to[0] - from[0]) * amount),
    Math.round(from[1] + (to[1] - from[1]) * amount),
    Math.round(from[2] + (to[2] - from[2]) * amount),
  ]
}

function colorCodes(palette: FrogPalette, prefix: 38 | 48): readonly string[] {
  return COLOR_NAMES.map((name) => {
    const [red, green, blue] = palette[name]
    return `${ESC}${prefix};2;${red};${green};${blue}m`
  })
}

export interface FrogAnimationRun {
  row: number
  column: number
  text: string
}

function selectPixelColor(
  candidates: readonly number[],
  indexes: readonly number[],
  colors: Int16Array,
  priorities: Int16Array
): number {
  const ranked = candidates.map((color) => {
    const matching = indexes.filter((index) => colors[index] === color)
    return {
      color,
      priority: Math.max(...matching.map((index) => priorities[index]!)),
      count: matching.length,
    }
  })
  return ranked.sort((left, right) => right.priority - left.priority || right.count - left.count)[0]!.color
}
