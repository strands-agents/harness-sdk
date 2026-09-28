import type { FrogTheme } from '../chat/types.js'
import { Canvas, type Color, type FrogAnimationRun, type FrogRenderOptions, type Point } from './frog-canvas.js'

import {
  FROG_POSES,
  drawTongue,
  drawPushingTongue,
  frogFootOffset,
  smoothStep,
  hopState,
  drawArrivalRipple,
  drawFrog,
  interpolatePose,
  fillEllipse,
  fillCircle,
  clamp,
  lerp,
  easeOutCubic,
  easeInOutCubic,
  hash01,
  type FrogPose,
  type FrogTransform,
} from './frog-drawing.js'

export type { FrogAnimationRun, FrogRenderOptions } from './frog-canvas.js'

export const FROG_INTRO_DURATION_MS = 4_200
const GLYPHS = {
  A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
  D: ['██████╗ ', '██╔══██╗', '██║  ██║', '██║  ██║', '██████╔╝', '╚═════╝ '],
  N: ['███╗   ██╗', '████╗  ██║', '██╔██╗ ██║', '██║╚██╗██║', '██║ ╚████║', '╚═╝  ╚═══╝'],
  R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
  S: ['███████╗', '██╔════╝', '███████╗', '╚════██║', '███████║', '╚══════╝'],
  T: ['████████╗', '╚══██╔══╝', '   ██║   ', '   ██║   ', '   ██║   ', '   ╚═╝   '],
} as const

const SMALL_GLYPHS = {
  A: ['▄▀█', '█▀█'],
  D: ['█▀▄', '█▄▀'],
  N: ['█▄ █', '█ ▀█'],
  R: ['█▀█', '█▀▄'],
  S: ['█▀▀', '▀▀█'],
  T: ['▀█▀', ' █ '],
} as const

const BRAND_WORD = wordShape('STRANDS')
const SMALL_BRAND_WORD = wordShape('STRANDS', SMALL_GLYPHS)
const BRAND_WORD_HEIGHT = GLYPHS.S.length

export const FROG_BRAND_EASTER_EGG_DURATION_MS = 3_200
export const FROG_FULL_LOCKUP_MIN_WIDTH = BRAND_WORD.width + 26

interface WordPoint extends Point {
  character: string
  index: number
  letterIndex: number
  localX: number
  localY: number
}

interface WordShape {
  points: readonly WordPoint[]
  width: number
}

interface Particle {
  angle: number
  depth: number
  radius: number
  speed: number
  strand: number
}

interface Scene {
  width: number
  height: number
  centerX: number
  centerY: number
  wordY: number
  sourceX: number
  source: WordShape
  particles: readonly Particle[]
}

export function renderFrogSpiralFrame(
  width: number,
  height: number,
  progress: number,
  elapsedMs: number,
  color = false,
  theme: FrogTheme = 'green',
  options: FrogRenderOptions = {},
  artHeight = frogStartupHeight(Math.max(1, width), Math.max(1, height) - 6),
  lockupLeft = 0
): string {
  const canvas = new Canvas(Math.max(1, width), Math.max(1, height), theme, false, 0, options)
  const top = artHeight > 2 ? 2 : 1
  const value = clamp(progress)
  if (artHeight < 12 || value >= 1) {
    const indent = ' '.repeat(lockupLeft)
    const artwork = renderFrogStartupLockup(canvas.width - lockupLeft, color, 0, theme, false, options, artHeight)
      .split('\n')
      .map((row) => indent + row)
    return canvas
      .rows(color)
      .map((row, index) => artwork[index - top] ?? row)
      .join('\n')
  }
  const scene = createScene(canvas.width, canvas.height, Math.max(12, Math.floor((canvas.height - 15) / 2)) + 3)
  if (value < 0.23) {
    drawSpiralAct(canvas, scene, value / 0.23, elapsedMs)
    return canvas.rows(color).join('\n')
  }
  const local = (value - 0.23) / 0.77
  drawDanglingLetterAct(canvas, scene, local, elapsedMs, lockupLeft)
  const wide = canvas.width >= BRAND_WORD.width + 26
  const shift = Math.round((scene.wordY - (wide ? 7 : 9)) * smoothStep((local - 0.51) / 0.17))
  const rows = canvas.rows(color)
  return rows.map((_, index) => rows[index + shift] ?? ' '.repeat(canvas.width)).join('\n')
}

export function renderFrogStartupLockup(
  width: number,
  color = false,
  elapsedMs = 0,
  theme: FrogTheme = 'green',
  party = false,
  options: FrogRenderOptions = {},
  height = lockupLayout(width).height
): string {
  const canvas = new Canvas(Math.max(1, width), Math.max(1, height), theme, party, elapsedMs, options)
  if (canvas.width < FROG_FULL_LOCKUP_MIN_WIDTH || canvas.height < lockupLayout(canvas.width).height) {
    drawCompactLockup(canvas)
    return canvas.rows(color).join('\n')
  }
  drawFinalLockup(canvas, elapsedMs)
  return canvas.rows(color).join('\n')
}

export function renderFrogBrandEasterEggFrame(
  width: number,
  progress: number,
  elapsedMs: number,
  color = false,
  theme: FrogTheme = 'green',
  party = false,
  partyElapsedMs = elapsedMs,
  options: FrogRenderOptions = {},
  height = lockupLayout(width).height
): string {
  const canvas = new Canvas(Math.max(1, width), Math.max(1, height), theme, party, partyElapsedMs, options)
  if (canvas.width < FROG_FULL_LOCKUP_MIN_WIDTH || canvas.height < lockupLayout(canvas.width).height) {
    drawCompactLockup(canvas)
    return canvas.rows(color).join('\n')
  }
  drawFrogBrandEasterEgg(canvas, clamp(progress), elapsedMs)
  return canvas.rows(color).join('\n')
}

export interface FrogStartupHitbox {
  left: number
  top: number
  width: number
  height: number
}

export function frogStartupHeight(width: number, availableHeight: number): number {
  if (width >= FROG_FULL_LOCKUP_MIN_WIDTH && availableHeight >= 26) {
    return lockupLayout(width).height
  }
  if (width >= BRAND_WORD.width && availableHeight >= wordOnlyHeight(width) + 8) {
    return wordOnlyHeight(width)
  }
  return width >= SMALL_BRAND_WORD.width && availableHeight >= 8 ? 2 : 1
}

/** The width the lockup artwork occupies at `height`, for centering it within `width`. */
export function frogStartupWidth(width: number, height: number): number {
  const canvasWidth = Math.max(1, width)
  if (canvasWidth >= FROG_FULL_LOCKUP_MIN_WIDTH && height >= lockupLayout(canvasWidth).height) {
    return FROG_FULL_LOCKUP_MIN_WIDTH
  }
  if (canvasWidth >= BRAND_WORD.width && height >= wordOnlyHeight(BRAND_WORD.width)) {
    return BRAND_WORD.width
  }
  if (canvasWidth >= SMALL_BRAND_WORD.width && height >= 2) {
    return SMALL_BRAND_WORD.width
  }
  return Math.min(canvasWidth, 'STRANDS'.length)
}

export function frogStartupHitbox(width: number, height = lockupLayout(width).height): FrogStartupHitbox {
  const canvasWidth = Math.max(1, width)
  if (
    canvasWidth >= BRAND_WORD.width &&
    height >= wordOnlyHeight(canvasWidth) &&
    height < lockupLayout(canvasWidth).height
  ) {
    return { left: 0, top: lockupLayout(canvasWidth).wordY, width: BRAND_WORD.width, height: BRAND_WORD_HEIGHT }
  }
  if (canvasWidth < FROG_FULL_LOCKUP_MIN_WIDTH || height < lockupLayout(canvasWidth).height) {
    return { left: 0, top: 0, width: Math.min(SMALL_BRAND_WORD.width, canvasWidth), height }
  }
  const { frogX, frogY } = lockupLayout(canvasWidth)
  const left = Math.max(0, Math.floor(frogX - 7))
  const right = Math.min(canvasWidth, Math.ceil(frogX + 7))
  return {
    left,
    top: Math.max(0, frogY / 2 - 5),
    width: Math.max(1, right - left),
    height: 12,
  }
}

export type FrogAnimationVariant = 'hop' | 'fly' | 'peek' | 'firefly'

export function renderFrogAnimationRuns(
  width: number,
  height: number,
  variant: FrogAnimationVariant,
  progress: number,
  elapsedMs: number,
  color = false,
  theme: FrogTheme = 'green',
  options: FrogRenderOptions = {}
): FrogAnimationRun[] {
  const canvas = new Canvas(Math.max(1, width), Math.max(1, height), theme, false, 0, options)
  const value = clamp(progress)
  if (variant === 'hop') {
    drawFrogHop(canvas, value, elapsedMs)
  } else if (variant === 'fly') {
    drawFrogFly(canvas, value, elapsedMs)
  } else if (variant === 'peek') {
    drawFrogPeek(canvas, value, elapsedMs)
  } else {
    drawFrogFireflies(canvas, value, elapsedMs)
  }
  return canvas.runs(color)
}

function drawFrogHop(canvas: Canvas, progress: number, elapsedMs: number): void {
  const groundY = canvas.height * 2 - 9
  const stops = [canvas.width + 10, canvas.width * 0.76, canvas.width * 0.52, canvas.width * 0.28, -10].map((x) => ({
    x,
    y: groundY,
  }))
  const scaledProgress = progress * (stops.length - 1)
  const segment = Math.min(stops.length - 2, Math.floor(scaledProgress))
  const local = scaledProgress - segment
  const state = hopState(stops[segment]!, stops[segment + 1]!, local)
  const landing = (local - 0.78) / 0.22
  if (landing > 0 && landing < 1) {
    drawArrivalRipple(canvas, stops[segment + 1]!.x, groundY, landing)
  }
  drawFrog(canvas, state.transform, state.pose, elapsedMs)
}

function drawFrogFly(canvas: Canvas, progress: number, elapsedMs: number): void {
  const groundY = canvas.height * 2 - 9
  const landing = { x: canvas.width * 0.7, y: groundY }
  const flyTarget = {
    x: canvas.width * 0.36,
    y: Math.max(4, canvas.height * 0.72),
  }
  const flyIn = easeOutCubic(progress / 0.28)
  const extension = easeOutCubic((progress - 0.58) / 0.14)
  const release = easeInOutCubic((progress - 0.74) / 0.1)
  const fly = {
    x: lerp(canvas.width + 4, flyTarget.x, flyIn) + Math.sin(elapsedMs / 95) * (1 - extension) * 2.4,
    y: flyTarget.y + Math.cos(elapsedMs / 80) * (1 - extension) * 2,
  }

  let frog: { pose: FrogPose; transform: FrogTransform } | undefined
  if (progress >= 0.2 && progress < 0.52) {
    frog = hopState({ x: canvas.width + 10, y: groundY }, landing, (progress - 0.2) / 0.32)
  } else if (progress >= 0.52 && progress < 0.84) {
    frog = {
      pose: interpolatePose(FROG_POSES.settled, FROG_POSES.reach, extension * (1 - release)),
      transform: { ...landing, scale: 0.9 },
    }
  } else if (progress >= 0.84) {
    frog = hopState(landing, { x: -10, y: groundY }, (progress - 0.84) / 0.16)
  }

  if (frog) {
    drawFrog(canvas, frog.transform, frog.pose, elapsedMs)
    drawTongue(canvas, frog, fly, extension, release)
  }
  if (progress < 0.77) {
    drawFly(canvas, fly, elapsedMs)
  }
}

function drawFly(canvas: Canvas, point: Point, elapsedMs: number): void {
  const flap = Math.sin(elapsedMs / 45) * 0.6
  fillCircle(canvas, point.x, point.y, 0.75, 'ink', 90)
  fillEllipse(canvas, point.x - 0.9, point.y - 0.7 - flap, 0.9, 0.45, 'white', 89, -0.35)
  fillEllipse(canvas, point.x + 0.9, point.y - 0.7 + flap, 0.9, 0.45, 'mint', 89, 0.35)
}

function drawFrogPeek(canvas: Canvas, progress: number, elapsedMs: number): void {
  const rise =
    progress < 0.25 ? easeOutCubic(progress / 0.25) : progress < 0.72 ? 1 : 1 - easeInOutCubic((progress - 0.72) / 0.28)
  drawFrog(
    canvas,
    {
      x: canvas.width * 0.68,
      y: lerp(canvas.height * 2 + 8, canvas.height * 2 - 1, rise),
      scale: 1,
      rotation: progress > 0.4 && progress < 0.62 ? Math.sin((progress - 0.4) * Math.PI * 9) * 0.045 : 0,
    },
    FROG_POSES.settled,
    elapsedMs
  )
}

function drawFrogFireflies(canvas: Canvas, progress: number, elapsedMs: number): void {
  const groundY = canvas.height * 2 - 9
  const landing = { x: canvas.width * 0.72, y: groundY }
  const swarmIn = easeOutCubic(progress / 0.34)
  const extension = easeOutCubic((progress - 0.52) / 0.14)
  const release = easeInOutCubic((progress - 0.7) / 0.1)
  const scatter = easeInOutCubic((progress - 0.64) / 0.2)
  const fireflies = Array.from({ length: 5 }, (_, index) => {
    const target = {
      x: canvas.width * (0.3 + index * 0.075),
      y: 5 + ((index * 5) % 9),
    }
    const phase = elapsedMs / 170 + index * 1.7
    return {
      x:
        lerp(canvas.width + 5 + index * 3, target.x, swarmIn) +
        Math.sin(phase) * 1.8 -
        (index === 0 ? 0 : scatter * (canvas.width * 0.45 + index * 3)),
      y: target.y + Math.cos(phase * 1.2) * 1.4 + (index === 0 ? 0 : Math.sin(index) * scatter * 5),
    }
  })
  let frog: { pose: FrogPose; transform: FrogTransform } | undefined
  if (progress >= 0.18 && progress < 0.48) {
    frog = hopState({ x: canvas.width + 10, y: groundY }, landing, (progress - 0.18) / 0.3)
  } else if (progress >= 0.48 && progress < 0.8) {
    frog = {
      pose: interpolatePose(FROG_POSES.settled, FROG_POSES.reach, extension * (1 - release)),
      transform: { ...landing, scale: 0.9 },
    }
  } else if (progress >= 0.8) {
    frog = hopState(landing, { x: -10, y: groundY }, (progress - 0.8) / 0.2)
  }

  for (const [index, firefly] of fireflies.entries()) {
    if (index > 0 || progress < 0.74) {
      drawFirefly(canvas, firefly, elapsedMs + index * 120)
    }
  }
  if (frog) {
    drawFrog(canvas, frog.transform, frog.pose, elapsedMs)
    drawTongue(canvas, frog, fireflies[0]!, extension, release)
    if (progress >= 0.72 && progress < 0.92) {
      drawFirefly(
        canvas,
        { x: frog.transform.x - 5, y: frog.transform.y - 5 },
        elapsedMs,
        1 - Math.max(0, (progress - 0.84) / 0.08)
      )
    }
  }
}

function drawFirefly(canvas: Canvas, point: Point, elapsedMs: number, glow = 1): void {
  const pulse = (0.65 + Math.sin(elapsedMs / 90) * 0.2) * glow
  fillCircle(canvas, point.x, point.y, 1.6 * pulse, 'green', 86)
  fillCircle(canvas, point.x, point.y, 0.8 * glow, 'lime', 88)
  fillCircle(canvas, point.x, point.y, 0.35 * glow, 'white', 90)
}

function createScene(width: number, height: number, wordY: number): Scene {
  const count = Math.max(86, Math.min(210, Math.round(width * 1.6)))
  const random = seededRandom(width * 7_919 + height * 104_729)
  const particles: Particle[] = []
  for (let index = 0; index < count; index++) {
    particles.push({
      angle: random() * Math.PI * 2,
      radius: 0.25 + random() * 0.75,
      depth: random(),
      speed: 0.65 + random() * 1.4,
      strand: index % 2,
    })
  }
  return {
    width,
    height,
    centerX: Math.floor(width / 2),
    centerY: wordY + 2,
    particles,
    source: BRAND_WORD,
    sourceX: Math.floor((width - BRAND_WORD.width) / 2),
    wordY,
  }
}

function drawSpiralAct(canvas: Canvas, scene: Scene, progress: number, elapsedMs: number): void {
  const seconds = elapsedMs / 1_000
  const reveal = easeOutCubic(progress / 0.3)
  const expansion = easeInOutCubic(progress / 0.32)
  const radiusX = Math.min(31, Math.max(13, scene.width * 0.3))
  const radiusY = Math.min(7, Math.max(3, scene.height * 0.22))
  const wipeProgress = easeInOutCubic((progress - 0.28) / 0.72)
  const wipeStart = Math.min(scene.centerX - radiusX - 3, scene.sourceX - 3)
  const wipeEnd = Math.max(scene.centerX + radiusX + 3, scene.sourceX + BRAND_WORD.width + 3)
  const wipeX = lerp(wipeStart, wipeEnd, wipeProgress)
  drawHelix(canvas, scene, expansion, seconds, radiusX, radiusY, wipeX)
  drawVortexParticles(canvas, scene, reveal, expansion, seconds, radiusX, radiusY, wipeX)
  drawWipeRevealedWord(canvas, BRAND_WORD, scene.sourceX, scene.wordY, wipeX, 68)
  if (wipeProgress > 0 && wipeProgress < 1) {
    drawDissolveFront(canvas, scene, wipeX, seconds)
  }
}

function drawDanglingLetterAct(canvas: Canvas, scene: Scene, time: number, elapsedMs: number, left: number): void {
  const wide = canvas.width >= BRAND_WORD.width + 26
  const layout = lockupLayout(canvas.width - left)
  const wordX = left + layout.wordX
  const frogX = left + layout.frogX
  const restingWordY = scene.wordY - 3
  const landing = { x: frogX, y: (restingWordY + (wide ? 3 : 8)) * 2, scale: 1 }
  const letters = [5, 2, 0]
  const impacts = letters.map((_, index) => (index + 1) * 0.17 - 0.015)
  const presses = impacts.map((impact) => {
    const age = time - impact
    return smoothStep(age / 0.018) * (1 - smoothStep((age - 0.07) / 0.05)) * 2
  })
  const stops = [
    { x: canvas.width + 10.5, y: scene.wordY * 2, scale: 0.9 },
    ...letters.map((index) => ({ x: letterCenter(scene, index), y: scene.wordY * 2, scale: 0.9 })),
    { ...landing, y: landing.y + frogFootOffset(landing, FROG_POSES.settled) + 1 },
  ]
  const segment = Math.min(3, Math.floor(time / 0.17))
  const local = (time - segment * 0.17) / 0.17
  const from = stops[segment]!
  const to = stops[segment + 1]!
  const state = hopState(from, to, clamp(local))
  const travel = easeInOutCubic(local)
  state.transform.scale = lerp(from.scale, to.scale, travel)
  if (to.scale === 1) {
    state.pose = interpolatePose(FROG_POSES.squash, FROG_POSES.settled, travel)
  }
  const frog = state.transform
  if (segment === 3 && local < 1) {
    frog.x -= Math.sin(Math.PI * local) * (wide ? 5 : 26)
  }
  // Hop waypoints describe the feet; the sprite renderer positions its center.
  frog.y = segment === 3 && local >= 1 ? landing.y : frog.y - frogFootOffset(frog, state.pose) - 1
  const titleX = lerp(scene.sourceX, wordX, smoothStep((time - 0.51) / 0.17))
  const titleY = lerp(scene.wordY, restingWordY - (wide ? 0 : 4), smoothStep((time - 0.51) / 0.17))
  const hangingLetter = letters[1]!
  const hangAge = Math.max(0, time - impacts[1]!)
  const hanging = smoothStep(hangAge / 0.035) * (1 - smoothStep((time - 0.81) / 0.085))
  const bobAge = Math.max(0, hangAge - 0.035)
  const drop = Math.round((2 + Math.sin(bobAge * 30) * 0.85 * Math.exp(-bobAge * 10)) * hanging)
  const sway = Math.round(Math.sin(hangAge * 20) * Math.exp(-hangAge * 4) * 0.9 * hanging)
  const points = BRAND_WORD.points.map((point) => {
    const dangling = point.letterIndex === hangingLetter
    return {
      ...point,
      x: point.x + (dangling ? sway : 0),
      y: point.y + (dangling ? drop : (presses[letters.indexOf(point.letterIndex)] ?? 0)),
    }
  })
  drawSolidWord(canvas, { ...BRAND_WORD, points }, titleX, titleY, 60)
  const reach =
    time > 0.74 && time < 0.97 ? smoothStep((time - 0.74) / 0.07) * (1 - smoothStep((time - 0.91) / 0.06)) : 0
  state.pose = interpolatePose(FROG_POSES.settled, FROG_POSES.reach, reach)
  drawFrog(canvas, frog, state.pose, elapsedMs)
  if (reach > 0) {
    drawPushingTongue(
      canvas,
      state,
      { x: letterCenter(scene, hangingLetter) + titleX - scene.sourceX - 2.5 + sway, y: (titleY + 6 + drop) * 2 },
      reach
    )
  }
}

function letterCenter(scene: Scene, letterIndex: number): number {
  const points = BRAND_WORD.points.filter((point) => point.letterIndex === letterIndex)
  return scene.sourceX + (Math.min(...points.map((point) => point.x)) + Math.max(...points.map((point) => point.x))) / 2
}

function drawFinalLockup(canvas: Canvas, elapsedMs: number): void {
  const layout = lockupLayout(canvas.width)
  drawSolidWord(canvas, BRAND_WORD, layout.wordX, layout.wordY, 68)
  drawFrog(canvas, { x: layout.frogX, y: layout.frogY, scale: 1 }, FROG_POSES.settled, elapsedMs)
}

function drawCompactLockup(canvas: Canvas): void {
  if (canvas.width >= BRAND_WORD.width && canvas.height >= wordOnlyHeight(canvas.width)) {
    drawSolidWord(canvas, BRAND_WORD, 0, lockupLayout(canvas.width).wordY, 68)
    return
  }
  if (canvas.width < SMALL_BRAND_WORD.width || canvas.height < 2) {
    for (const [index, character] of [...'STRANDS'.slice(0, canvas.width)].entries()) {
      canvas.set(index, 0, character, 'green', 68)
    }
    return
  }
  drawSolidWord(canvas, SMALL_BRAND_WORD, 0, 0, 68)
}

function drawFrogBrandEasterEgg(canvas: Canvas, progress: number, elapsedMs: number): void {
  if (progress <= 0 || progress >= 1) {
    drawFinalLockup(canvas, elapsedMs)
    return
  }
  const layout = lockupLayout(canvas.width)
  const dissolve = easeInOutCubic((progress - 0.16) / 0.3)
  const reform = easeInOutCubic((progress - 0.62) / 0.22)
  const vortex = dissolve * (1 - reform)
  if (vortex <= 0) {
    drawSolidWord(canvas, BRAND_WORD, layout.wordX, layout.wordY, 68)
  } else {
    const scene = createScene(canvas.width, canvas.height, layout.wordY)
    scene.centerX = layout.wordX + (BRAND_WORD.width - 1) / 2
    scene.centerY = layout.wordY + 2.5
    const radiusX = Math.min(31, BRAND_WORD.width / 2)
    const radiusY = Math.min(3, scene.centerY, canvas.height - 1 - scene.centerY)
    const seconds = elapsedMs / 1_000
    const wipeX = scene.centerX - radiusX - 8
    drawHelix(canvas, scene, vortex, seconds, radiusX, radiusY, wipeX)
    drawVortexParticles(canvas, scene, vortex, vortex, seconds, radiusX, radiusY, wipeX)
    for (const point of BRAND_WORD.points) {
      const angle = hash01(point.index * 71 + 13) * Math.PI * 2 + elapsedMs / 180
      const radius = 3 + hash01(point.index * 97 + 29) * 12
      canvas.set(
        lerp(layout.wordX + point.x, scene.centerX + Math.cos(angle) * radius, vortex),
        lerp(layout.wordY + point.y, scene.centerY + Math.sin(angle) * Math.min(radius * 0.32, radiusY), vortex),
        vortex < 0.3 ? point.character : vortex < 0.68 ? '▒' : '·',
        wordColor(canvas, point),
        68
      )
    }
  }
  drawBrandFrogJump(canvas, layout.frogX, layout.frogY, progress, elapsedMs)
}

function drawBrandFrogJump(canvas: Canvas, frogX: number, baseY: number, progress: number, elapsedMs: number): void {
  const start = { x: frogX, y: baseY }
  const offscreen = { x: frogX - 8, y: -16 }
  if (progress < 0.2) {
    if (progress < 0.04) {
      drawFrog(
        canvas,
        { ...start, scale: 1 },
        interpolatePose(FROG_POSES.settled, FROG_POSES.crouch, easeInOutCubic(progress / 0.04)),
        elapsedMs
      )
      return
    }
    const jump = (progress - 0.04) / 0.16
    const state = hopState(start, offscreen, jump)
    state.transform.scale = lerp(1, 0.9, Math.min(1, jump / 0.18))
    drawFrog(canvas, state.transform, state.pose, elapsedMs)
    return
  }

  if (progress > 0.8) {
    if (progress < 0.96) {
      const landing = (progress - 0.8) / 0.16
      const state = hopState(offscreen, start, landing)
      state.transform.scale = lerp(0.9, 1, Math.max(0, (landing - 0.76) / 0.24))
      if (landing > 0.76) {
        drawArrivalRipple(canvas, frogX, baseY, (landing - 0.76) / 0.24)
      }
      drawFrog(canvas, state.transform, state.pose, elapsedMs)
      return
    }
    drawFrog(
      canvas,
      { ...start, scale: 1 },
      interpolatePose(FROG_POSES.squash, FROG_POSES.settled, easeInOutCubic((progress - 0.96) / 0.04)),
      elapsedMs
    )
  }
}

function drawSolidWord(canvas: Canvas, word: WordShape, originX: number, originY: number, priority: number): void {
  const accent = canvas.theme === 'circuit' ? 'blue' : canvas.theme === 'spectre' ? 'red' : undefined
  if (accent) {
    for (const point of word.points) {
      canvas.set(originX + point.x + 1, originY + point.y + 1, '░', accent, priority - 1)
    }
  }
  for (const point of word.points) {
    canvas.set(originX + point.x, originY + point.y, point.character, wordColor(canvas, point), priority)
  }
}

function wordColor(canvas: Canvas, point: WordPoint): Color {
  if (canvas.theme === 'homeland') {
    const region = (Math.floor(point.localX / 3) + Math.floor(point.localY / 2) + point.letterIndex * 2) % 5
    return region < 2 ? (region === 0 ? 'lime' : 'green') : region === 2 ? 'cyan' : 'blue'
  }
  if (canvas.theme === 'circuit') {
    return point.index % 19 === 0 ? 'tongue' : 'lime'
  }
  if (canvas.theme === 'spectre') {
    return point.localY === 5 ? 'red' : 'mint'
  }
  if (canvas.theme === 'merlin') {
    return point.index % 23 === 0 ? 'white' : 'lime'
  }
  return 'lime'
}

function drawWipeRevealedWord(
  canvas: Canvas,
  word: WordShape,
  originX: number,
  originY: number,
  wipeX: number,
  priority: number
): void {
  for (const point of word.points) {
    if (originX + point.x > wipeX) {
      continue
    }
    canvas.set(originX + point.x, originY + point.y, point.character, wordColor(canvas, point), priority)
  }
}

function drawDissolveFront(canvas: Canvas, scene: Scene, wipeX: number, seconds: number): void {
  const top = Math.max(0, scene.centerY - 8)
  const bottom = Math.min(scene.height - 1, scene.centerY + 8)
  for (let row = top; row <= bottom; row++) {
    const seed = row * 37 + Math.floor(seconds * 16)
    if (hash01(seed) < 0.38) {
      continue
    }
    const drift = Math.round((hash01(seed + 11) - 0.5) * 4)
    canvas.set(
      wipeX + drift,
      row,
      hash01(seed + 23) > 0.7 ? '◆' : hash01(seed + 31) > 0.45 ? '∙' : '·',
      hash01(seed + 43) > 0.65 ? 'mint' : 'emerald',
      24
    )
  }
}

/** The full lockup cropped below the wordmark, so dropping the frog keeps the word on the same rows. */
function wordOnlyHeight(width: number): number {
  return lockupLayout(width).wordY + BRAND_WORD_HEIGHT
}

function lockupLayout(width: number): { frogX: number; frogY: number; wordX: number; wordY: number; height: number } {
  const wide = width >= BRAND_WORD.width + 26
  const wordX = wide ? 26 : 0
  return {
    frogX: wide ? wordX - 15.5 : 10.5,
    frogY: wide ? 10 : 24,
    wordX,
    wordY: wide ? 2 : 0,
    height: wide ? 12 : 19,
  }
}

function drawHelix(
  canvas: Canvas,
  scene: Scene,
  expansion: number,
  seconds: number,
  radiusX: number,
  radiusY: number,
  wipeX: number
): void {
  const sampleCount = Math.max(21, Math.min(69, Math.round(scene.width * 0.5)))
  const samples = sampleCount % 2 === 0 ? sampleCount + 1 : sampleCount
  const activeRadiusY = radiusY * expansion
  let previousA: Point | undefined
  let previousB: Point | undefined
  for (let index = 0; index < samples; index++) {
    const phase = index / (samples - 1)
    if (Math.abs(phase - 0.5) * 2 > expansion) {
      previousA = undefined
      previousB = undefined
      continue
    }
    const x = scene.centerX - radiusX + phase * radiusX * 2
    const angle = phase * Math.PI * 4 + seconds * 2.3
    const depth = Math.cos(angle)
    const a = { x, y: scene.centerY + Math.sin(angle) * activeRadiusY }
    const b = { x, y: scene.centerY + Math.sin(angle + Math.PI) * activeRadiusY }
    const visibleA = hash01(index * 47 + 13) <= spiralPresence(a.x, wipeX, index * 47 + 13)
    const visibleB = hash01(index * 47 + 29) <= spiralPresence(b.x, wipeX, index * 47 + 29)
    if (previousA && visibleA) {
      canvas.line(previousA, a, depth > 0 ? '━' : '─', depth > 0 ? 'green' : 'forest', 13)
    }
    if (previousB && visibleB) {
      canvas.line(previousB, b, depth < 0 ? '━' : '─', depth < 0 ? 'mint' : 'emerald', 13)
    }
    if (
      index % 4 === 0 &&
      Math.min(hash01(index * 61 + 7), hash01(index * 61 + 19)) <= spiralPresence(x, wipeX, index * 61 + 7)
    ) {
      canvas.line(a, b, '·', 'dim', 8)
    }
    if (visibleA) {
      canvas.set(a.x, a.y, depth > 0 ? '●' : '•', depth > 0 ? 'green' : 'forest', 18)
    }
    if (visibleB) {
      canvas.set(b.x, b.y, depth < 0 ? '●' : '•', depth < 0 ? 'mint' : 'emerald', 18)
    }
    previousA = visibleA ? a : undefined
    previousB = visibleB ? b : undefined
  }
}

function drawVortexParticles(
  canvas: Canvas,
  scene: Scene,
  reveal: number,
  expansion: number,
  seconds: number,
  radiusX: number,
  radiusY: number,
  wipeX: number
): void {
  const visible = Math.floor(scene.particles.length * reveal)
  for (let index = 0; index < visible; index++) {
    const particle = scene.particles[index]!
    const direction = particle.strand === 0 ? 1 : -1
    const angle = particle.angle + direction * seconds * particle.speed
    const radiusScale = 0.35 + particle.radius * 0.65
    const x = scene.centerX + Math.cos(angle) * radiusX * radiusScale * expansion
    const y = scene.centerY + Math.sin(angle * 1.7) * radiusY * radiusScale * expansion
    if (hash01(index * 53 + 11) > spiralPresence(x, wipeX, index * 53 + 11)) {
      continue
    }
    const bright = particle.depth > 0.72
    canvas.set(
      x,
      y,
      bright ? (particle.strand === 0 ? '◆' : '◇') : index % 3 === 0 ? '∙' : '·',
      bright ? (particle.strand === 0 ? 'green' : 'mint') : particle.strand === 0 ? 'emerald' : 'forest',
      bright ? 22 : 16
    )
  }
}

function spiralPresence(x: number, wipeX: number, seed: number): number {
  const distance = x - wipeX
  if (distance <= 0) {
    return 0
  }
  if (distance >= 6) {
    return 1
  }
  return clamp(distance / 6 + (hash01(seed + 97) - 0.5) * 0.28)
}

function wordShape(word: string, glyphs: Record<string, readonly string[]> = GLYPHS): WordShape {
  const points: WordPoint[] = []
  let offset = 0
  for (const [letterIndex, rawLetter] of [...word].entries()) {
    const glyph = glyphs[rawLetter]!
    for (let localY = 0; localY < glyph.length; localY++) {
      const row = glyph[localY]!
      for (let localX = 0; localX < row.length; localX++) {
        const character = row[localX]!
        if (character !== ' ') {
          points.push({
            character,
            index: points.length,
            letterIndex,
            localX,
            localY,
            x: offset + localX,
            y: localY,
          })
        }
      }
    }
    offset += Math.max(...glyph.map((row) => row.length)) + 1
  }
  return { points, width: offset - 1 }
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0
  return (): number => {
    value = (value * 1_664_525 + 1_013_904_223) >>> 0
    return value / 0x1_0000_0000
  }
}
