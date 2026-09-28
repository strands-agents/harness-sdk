import { basename } from 'node:path'

import type { FrogTheme, PondFrog } from '../chat/types.js'
import { Canvas, type Color, type FrogRenderOptions } from './frog-canvas.js'
import { hash01 } from './frog-drawing.js'

// A pad slot holds one session frog, its pad, its label, and up to MAX_PAD_SUBAGENTS subagent frogs around it.
const SLOT_WIDTH = 32
const SLOT_HEIGHT = 10
const COVE_GUTTER = 6
const SHELF_GUTTER = 1
const MAX_PAD_SUBAGENTS = 4
const PAD_RADIUS_X = 9
const PAD_RADIUS_Y = 3.4
const PAD_FACETS = 9
const SHORE_VERTICES = 24
const RIPPLE_CELL_WIDTH = 9
const RIPPLE_CELL_HEIGHT = 4
const LABEL_WIDTH = SLOT_WIDTH - 8

// Everything is drawn on a grid of pixels one cell wide and half a cell tall. They read square in a terminal,
// and each cell then holds at most two colors, which is all a quadrant glyph can show.
// L lit skin, G skin, E shaded skin, F mouth, W eye white, P pupil, Y crown. Sprites get an ink outline.
const SESSION_FROG = ['.WW...WW.', 'WPWL.LWPW', 'LLLLLGGGE', 'LFFFFFFGE', 'LLLLGGGEE', '.LLGGGEE.', 'LL.....EE']
const SUBAGENT_FROG = ['.WW.WW.', 'WPWLWPW', 'LLLLGGE', 'LFFFFGE', '.LLGGE.']
const CROWN = ['Y.Y.Y', 'YYYYY']
// Subagent sprite centers relative to the pad center: x in cells, y in canvas pixels (sprite bottom edge).
const SUBAGENT_SLOTS = [
  { x: -5, y: 5 },
  { x: 5, y: 5 },
  { x: -11, y: 1 },
  { x: 11, y: 1 },
] as const

type SpriteKey = 'L' | 'G' | 'E' | 'F' | 'W' | 'P' | 'Y'
type SpritePalette = Record<SpriteKey, Color>

const AWAKE_SKIN: SpritePalette = {
  L: 'lime',
  G: 'green',
  E: 'emerald',
  F: 'forest',
  W: 'white',
  P: 'ink',
  Y: 'yellow',
}
const SKINS: Record<PondFrog['state'], SpritePalette> = {
  working: AWAKE_SKIN,
  awake: AWAKE_SKIN,
  asleep: { ...AWAKE_SKIN, L: 'gray', G: 'gray', E: 'dim', F: 'ink', W: 'gray', P: 'ink' },
  failed: { ...AWAKE_SKIN, W: 'red', P: 'red' },
}

export interface PondHitBox {
  index: number
  left: number
  top: number
  width: number
  height: number
}

export interface PondScene {
  lines: string[]
  hitBoxes: PondHitBox[]
  /** World height in rows; the view scrolls over it. */
  worldHeight: number
}

interface PadGroup {
  key: string
  cove: string
  session?: number
  subagents: number[]
}

interface PadPlacement {
  pad: PadGroup
  /** Pad center: x in cells, y in rows. */
  x: number
  y: number
}

interface CovePlacement {
  name: string
  left: number
  top: number
  width: number
  height: number
}

export interface PondLayout {
  pads: PadPlacement[]
  coves: CovePlacement[]
  height: number
}

/** The drawable pond area inside the full-screen panel, which also holds a title and two detail rows. */
export function pondCanvasSize(terminalWidth: number, terminalHeight: number): { width: number; height: number } {
  return { width: Math.max(1, terminalWidth - 6), height: Math.max(3, terminalHeight - 6) }
}

/**
 * Packs each workspace's pads into its own pond, row after row. The world grows downward without
 * limit, so every frog gets a place and the view scrolls instead of dropping frogs.
 */
export function layoutPond(frogs: readonly PondFrog[], width: number): PondLayout {
  const maximumColumns = Math.max(1, Math.floor(width / SLOT_WIDTH))
  const blocks: { name: string; pads: PadGroup[]; left: number; top: number; columns: number; shelf: number }[] = []
  const shelfWidths: number[] = []
  let left = 0
  let top = 0
  let shelfHeight = 0
  for (const cove of groupCoves(frogs)) {
    const columns = Math.min(maximumColumns, cove.pads.length, Math.ceil(Math.sqrt(cove.pads.length * 2)))
    if (left > 0 && left + COVE_GUTTER + columns * SLOT_WIDTH > width) {
      top += shelfHeight + SHELF_GUTTER
      left = 0
      shelfHeight = 0
    }
    const offset = left > 0 ? COVE_GUTTER : 0
    const shelf = left === 0 ? shelfWidths.length : shelfWidths.length - 1
    blocks.push({ name: cove.name, pads: cove.pads, left: left + offset, top, columns, shelf })
    left += offset + columns * SLOT_WIDTH
    shelfWidths[shelf] = left
    shelfHeight = Math.max(shelfHeight, Math.ceil(cove.pads.length / columns) * SLOT_HEIGHT + 1)
  }

  const pads: PadPlacement[] = []
  const coves: CovePlacement[] = []
  for (const block of blocks) {
    const blockLeft = block.left + Math.max(0, Math.floor((width - shelfWidths[block.shelf]!) / 2))
    const rows = Math.ceil(block.pads.length / block.columns)
    coves.push({
      name: block.name,
      left: blockLeft,
      top: block.top,
      width: block.columns * SLOT_WIDTH,
      height: rows * SLOT_HEIGHT + 1,
    })
    for (const [index, pad] of block.pads.entries()) {
      pads.push({
        pad,
        x: Math.round(blockLeft + ((index % block.columns) + 0.5) * SLOT_WIDTH + (hash01(keySeed(pad.key)) - 0.5) * 2),
        y: block.top + 1 + Math.floor(index / block.columns) * SLOT_HEIGHT + 6,
      })
    }
  }
  return { pads, coves, height: top + shelfHeight }
}

/** Clamps a scroll offset (in rows) to the world. */
export function clampPondScroll(frogs: readonly PondFrog[], canvas: PondCanvas, scroll: number): number {
  return Math.max(0, Math.min(scroll, layoutPond(frogs, canvas.width).height - canvas.height))
}

/** The smallest scroll change that brings a frog's whole pad into view. */
export function revealPondFrog(frogs: readonly PondFrog[], canvas: PondCanvas, scroll: number, index: number): number {
  const placement = layoutPond(frogs, canvas.width).pads.find(
    ({ pad }) => pad.session === index || pad.subagents.includes(index)
  )
  if (!placement) {
    return clampPondScroll(frogs, canvas, scroll)
  }
  const top = placement.y - 7
  const bottom = placement.y + 3
  const next = top < scroll ? top : bottom >= scroll + canvas.height ? bottom - canvas.height + 1 : scroll
  return clampPondScroll(frogs, canvas, next)
}

type PondCanvas = { width: number; height: number }

export function renderPond(
  frogs: readonly PondFrog[],
  labels: readonly string[],
  width: number,
  height: number,
  options: {
    elapsedMs: number
    highlighted?: number
    scroll?: number
    color: boolean
    theme: FrogTheme
    render?: FrogRenderOptions
  }
): PondScene {
  const canvas = new Canvas(Math.max(1, width), Math.max(1, height), options.theme, false, 0, options.render)
  const world = layoutPond(frogs, width)
  const scroll = Math.max(0, Math.min(options.scroll ?? 0, world.height - height))
  // A pond shorter than the view sits in its middle; a taller one scrolls.
  const shift = world.height < height ? Math.floor((height - world.height) / 2) : -scroll
  const coves = world.coves.map((cove) => ({ ...cove, top: cove.top + shift }))
  const pads = world.pads
    .map((placement) => ({ ...placement, y: placement.y + shift }))
    .filter((placement) => placement.y + 4 >= 0 && placement.y - 8 < height)
  const { elapsedMs } = options
  drawLand(canvas, coves, elapsedMs)
  for (const cove of coves) {
    const name = basename(cove.name) || cove.name
    canvas.label(cove.left + 1, cove.top, ` ${name.slice(0, cove.width - 3)} `, 'mint', 'ink', 95)
  }

  const hitBoxes: PondHitBox[] = []
  for (const placement of pads) {
    const { pad } = placement
    const centerX = placement.x
    const centerY = placement.y * 2
    const session = pad.session === undefined ? undefined : frogs[pad.session]
    if (session?.state === 'working') {
      drawRipple(canvas, centerX, centerY, PAD_RADIUS_X, PAD_RADIUS_Y, (elapsedMs + keySeed(pad.key) * 7) % 1_800)
    }
    drawLilyPad(canvas, centerX, centerY, keySeed(pad.key))

    if (session && pad.session !== undefined) {
      const hop = frogHop(session.state, elapsedMs, keySeed(pad.key))
      const left = centerX - 4
      const top = centerY - 2 - SESSION_FROG.length - hop
      drawSprite(canvas, SESSION_FROG, left, top, spriteSkin(session.state, elapsedMs, keySeed(pad.key)), 60)
      if (session.current) {
        drawSprite(canvas, CROWN, centerX - 2, top - CROWN.length, AWAKE_SKIN, 61)
      }
      if (session.state === 'asleep') {
        drawSnore(canvas, centerX + 6, Math.floor(top / 2), elapsedMs, keySeed(pad.key))
      }
      const label = (labels[pad.session] ?? '').slice(0, LABEL_WIDTH)
      const labelRow = placement.y + 3
      canvas.label(
        centerX - Math.floor(label.length / 2),
        labelRow,
        label,
        session.current ? 'yellow' : session.state === 'asleep' ? 'gray' : 'white',
        'ink',
        55
      )
      const boxWidth = Math.max(SESSION_FROG[0]!.length + 2, label.length)
      const boxTop = Math.floor(top / 2)
      hitBoxes.push({
        index: pad.session,
        left: centerX - Math.floor(boxWidth / 2),
        top: boxTop,
        width: boxWidth,
        height: labelRow - boxTop + 1,
      })
    }

    for (const [slot, index] of pad.subagents.slice(0, MAX_PAD_SUBAGENTS).entries()) {
      const frog = frogs[index]!
      const offset = SUBAGENT_SLOTS[slot]!
      const seed = keySeed(pad.key) + slot * 13
      const hop = frogHop(frog.state, elapsedMs, seed)
      const left = centerX + offset.x - Math.floor(SUBAGENT_FROG[0]!.length / 2)
      const top = centerY + offset.y - SUBAGENT_FROG.length - hop
      if (frog.state === 'working') {
        drawRipple(canvas, centerX + offset.x, centerY + offset.y, 3, 1.4, (elapsedMs + seed * 11) % 1_400)
      }
      drawSprite(canvas, SUBAGENT_FROG, left, top, spriteSkin(frog.state, elapsedMs, seed), 65)
      hitBoxes.push({
        index,
        left: left - 1,
        top: Math.floor((top - 1) / 2),
        width: SUBAGENT_FROG[0]!.length + 2,
        height: 3,
      })
    }
    const overflow = pad.subagents.length - MAX_PAD_SUBAGENTS
    if (overflow > 0) {
      canvas.label(centerX + 12, placement.y - 4, `+${overflow}`, 'white', 'ink', 95)
    }
  }

  const visible = hitBoxes.flatMap((box) => clipBox(box, height))
  // A subagent past the seats on its pad highlights the pad's session frog, next to its "+N".
  const overflowOwner = pads.find(({ pad }) => pad.subagents.indexOf(options.highlighted ?? -1) >= MAX_PAD_SUBAGENTS)
  const highlighted =
    visible.find((box) => box.index === options.highlighted) ??
    visible.find((box) => box.index === overflowOwner?.pad.session)
  if (highlighted && Math.floor(elapsedMs / 400) % 3 !== 2) {
    drawCursor(canvas, highlighted)
  }
  return { lines: canvas.rows(options.color), hitBoxes: visible, worldHeight: world.height }
}

function clipBox(box: PondHitBox, height: number): PondHitBox[] {
  const top = Math.max(0, box.top)
  const bottom = Math.min(height, box.top + box.height)
  return bottom > top ? [{ ...box, top, height: bottom - top }] : []
}

function groupCoves(frogs: readonly PondFrog[]): { name: string; pads: PadGroup[] }[] {
  const coves = new Map<string, Map<string, PadGroup>>()
  for (const [index, frog] of frogs.entries()) {
    const pads = coves.get(frog.cove) ?? new Map<string, PadGroup>()
    coves.set(frog.cove, pads)
    const pad = pads.get(frog.pad) ?? { key: frog.pad, cove: frog.cove, subagents: [] }
    pads.set(frog.pad, pad)
    if (frog.kind === 'session' && pad.session === undefined) {
      pad.session = index
    } else {
      pad.subagents.push(index)
    }
  }
  return [...coves].map(([name, pads]) => ({ name, pads: [...pads.values()] }))
}

function drawLand(canvas: Canvas, coves: readonly CovePlacement[], elapsedMs: number): void {
  const drift = Math.floor(elapsedMs / 900)
  const ponds = coves
    .map((cove) => ({ cove, shore: pondShore(cove) }))
    .filter(({ cove }) => cove.top + cove.height + 2 >= 0 && cove.top - 2 < canvas.height)
  for (let py = 0; py < canvas.height * 2; py++) {
    for (let column = 0; column < canvas.width; column++) {
      const water = ponds.some(({ shore }) => insidePolygon(shore, column + 0.5, py + 0.5))
      plot(canvas, column, py, water ? (rippleAt(column, py, drift) ? 'blue' : 'ink') : grassAt(column, py), 0)
    }
  }
}

/**
 * A pond is a jittered polygon around its workspace's pads: a squarish superellipse, so the water
 * reaches every pad slot, with straight low-poly edges between vertices.
 */
function pondShore(cove: CovePlacement): { x: number; y: number }[] {
  const centerX = cove.left + cove.width / 2
  const centerY = (cove.top + 0.5 + cove.height / 2) * 2
  const radiusX = cove.width / 2 + 1
  const radiusY = cove.height - 0.5
  const seed = keySeed(basename(cove.name) || cove.name)
  return Array.from({ length: SHORE_VERTICES }, (_, index) => {
    const angle = (index / SHORE_VERTICES) * Math.PI * 2
    const cosine = Math.cos(angle)
    const sine = Math.sin(angle)
    const scale = 1 + (hash01(seed + index * 7) - 0.5) * 0.12
    return {
      x: centerX + Math.sign(cosine) * Math.abs(cosine) ** 0.35 * radiusX * scale,
      y: centerY + Math.sign(sine) * Math.abs(sine) ** 0.35 * radiusY * scale,
    }
  })
}

function insidePolygon(polygon: readonly { x: number; y: number }[], x: number, y: number): boolean {
  let inside = false
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const from = polygon[index]!
    const to = polygon[previous]!
    if (from.y > y !== to.y > y && x < ((to.x - from.x) * (y - from.y)) / (to.y - from.y) + from.x) {
      inside = !inside
    }
  }
  return inside
}

// Short grass blades and the odd flower on the meadow around the ponds.
function grassAt(column: number, py: number): Color {
  const noise = hash01(column * 57 + py * 131)
  if (noise > 0.995) {
    return noise > 0.9975 ? 'yellow' : 'pink'
  }
  return noise > 0.95 && hash01(column * 57 + (py + 1) * 131) > 0.6 ? 'emerald' : 'forest'
}

// Sparse horizontal ripple dashes on open water that shift a cell every so often.
function rippleAt(column: number, py: number, drift: number): boolean {
  const cellX = Math.floor(column / RIPPLE_CELL_WIDTH)
  const cellY = Math.floor(py / RIPPLE_CELL_HEIGHT)
  const seed = cellX * 131 + cellY * 977
  if (hash01(seed) > 0.3 || py % RIPPLE_CELL_HEIGHT !== Math.floor(hash01(seed + 1) * RIPPLE_CELL_HEIGHT)) {
    return false
  }
  const start =
    Math.floor(hash01(seed + 2) * (RIPPLE_CELL_WIDTH - 4)) + ((drift + Math.floor(hash01(seed + 3) * 4)) % 2)
  const offset = (column % RIPPLE_CELL_WIDTH) - start
  return offset >= 0 && offset < 2 + Math.floor(hash01(seed + 4) * 2)
}

function drawLilyPad(canvas: Canvas, centerX: number, centerY: number, seed: number): void {
  const notch = Math.floor(hash01(seed + 3) * PAD_FACETS)
  const vertices = Array.from({ length: PAD_FACETS }, (_, index) => {
    const angle = (index / PAD_FACETS) * Math.PI * 2 + (hash01(seed + index) - 0.5) * 0.3
    const radius = 0.9 + hash01(seed * 3 + index) * 0.16
    return {
      x: centerX + Math.cos(angle) * PAD_RADIUS_X * radius,
      y: centerY + Math.sin(angle) * PAD_RADIUS_Y * radius,
    }
  })
  for (let py = Math.floor(centerY - PAD_RADIUS_Y - 1); py <= Math.ceil(centerY + PAD_RADIUS_Y + 1); py++) {
    for (
      let column = Math.floor(centerX - PAD_RADIUS_X - 1);
      column <= Math.ceil(centerX + PAD_RADIUS_X + 1);
      column++
    ) {
      const color = padFacetColor(vertices, notch, centerX, centerY, column, py)
      if (!color) {
        continue
      }
      plot(canvas, column, py, color, 20)
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        plot(canvas, column + dx, py + dy, 'ink', 19)
      }
    }
  }
}

function padFacetColor(
  vertices: readonly { x: number; y: number }[],
  notch: number,
  centerX: number,
  centerY: number,
  column: number,
  py: number
): Color | undefined {
  for (let index = 0; index < PAD_FACETS; index++) {
    const from = vertices[index]!
    const to = vertices[(index + 1) % PAD_FACETS]!
    if (index !== notch && insideTriangle(column + 0.25, py, centerX, centerY, from.x, from.y, to.x, to.y)) {
      // Flat shading lit from the top left: facets facing the light are brighter.
      const facing = -(from.x + to.x - centerX * 2) / PAD_RADIUS_X - (from.y + to.y - centerY * 2) / PAD_RADIUS_Y
      return facing > 0.4 ? 'emerald' : 'forest'
    }
  }
  return undefined
}

function insideTriangle(
  x: number,
  y: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
): boolean {
  const first = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
  const second = (cx - bx) * (y - by) - (cy - by) * (x - bx)
  const third = (ax - cx) * (y - cy) - (ay - cy) * (x - cx)
  return (first >= 0 && second >= 0 && third >= 0) || (first <= 0 && second <= 0 && third <= 0)
}

function drawSprite(
  canvas: Canvas,
  sprite: readonly string[],
  left: number,
  top: number,
  skin: SpritePalette,
  priority: number
): void {
  const opaque = (column: number, row: number): boolean => (sprite[row]?.[column] ?? '.') !== '.'
  for (let row = -1; row <= sprite.length; row++) {
    for (let column = -1; column <= sprite[0]!.length; column++) {
      if (opaque(column, row)) {
        plot(canvas, left + column, top + row, skin[sprite[row]![column] as SpriteKey], priority)
      } else if ([-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => opaque(column + dx, row + dy)))) {
        plot(canvas, left + column, top + row, 'ink', priority - 1)
      }
    }
  }
}

/** Paints one grid pixel: a full cell width, half a cell tall. */
function plot(canvas: Canvas, column: number, py: number, color: Color, priority: number): void {
  canvas.setPixel(column, py, color, priority)
  canvas.setPixel(column + 0.5, py, color, priority)
}

function spriteSkin(state: PondFrog['state'], elapsedMs: number, seed: number): SpritePalette {
  const skin = SKINS[state]
  // Awake frogs blink for one frame every few seconds.
  const blinking = state !== 'asleep' && Math.floor(elapsedMs / 150 + seed) % 23 === 0
  return blinking ? { ...skin, W: skin.L, P: skin.F } : skin
}

function frogHop(state: PondFrog['state'], elapsedMs: number, seed: number): number {
  if (state !== 'working') {
    return 0
  }
  const phase = ((elapsedMs + seed * 97) % 1_200) / 1_200
  return phase < 0.3 ? Math.round(Math.sin((phase / 0.3) * Math.PI) * 2) : 0
}

function drawRipple(canvas: Canvas, x: number, y: number, radiusX: number, radiusY: number, ageMs: number): void {
  const progress = ageMs / 1_800
  const scale = 1 + progress * 0.6
  for (let step = 0; step < 48; step++) {
    const angle = (step / 48) * Math.PI * 2
    plot(
      canvas,
      Math.round(x + Math.cos(angle) * radiusX * scale),
      Math.round(y + Math.sin(angle) * radiusY * scale),
      progress < 0.5 ? 'cyan' : 'blue',
      10
    )
  }
}

function drawSnore(canvas: Canvas, column: number, row: number, elapsedMs: number, seed: number): void {
  const phase = Math.floor(elapsedMs / 600 + seed) % 3
  canvas.label(column, row, 'z', 'white', 'dim', 58)
  if (phase > 0) {
    canvas.label(column + 1, row - 1, phase === 1 ? 'z' : 'Z', 'white', 'dim', 58)
  }
}

function drawCursor(canvas: Canvas, box: PondHitBox): void {
  const left = box.left - 1
  const right = box.left + box.width
  const top = box.top * 2 - 1
  const bottom = (box.top + box.height) * 2
  for (const [column, py, dx, dy] of [
    [left, top, 1, 1],
    [right, top, -1, 1],
    [left, bottom, 1, -1],
    [right, bottom, -1, -1],
  ] as const) {
    plot(canvas, column, py, 'yellow', 90)
    plot(canvas, column + dx, py, 'yellow', 90)
    plot(canvas, column, py + dy, 'yellow', 90)
  }
}

function keySeed(key: string): number {
  let hash = 0
  for (const character of key) {
    hash = (hash * 31 + character.charCodeAt(0)) % 10_007
  }
  return hash
}
