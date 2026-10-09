import type { Canvas, Color, PixelSink, Point } from './frog-canvas.js'

const FROG_BITMAP = [
  '...###......###.......',
  '..#...#....#...#......',
  '.#.##..#..#.##..#.....',
  '.#.##..#..#.##..#.....',
  '.#......##......#.....',
  '..#..............#....',
  '..#....#..........#...',
  '.#..###...........#...',
  '.#.................#..',
  '#..................#..',
  '#............##.....#.',
  '#...........#.......#.',
  '#.#####....#........#.',
  '##.....#...#........#.',
  '#.......#..#........#.',
  '#.......#..#........#.',
  '.#......#...#.......#.',
  '..##.....#...#.....#..',
  '.##.#.....###.....#...',
  '#....######......#....',
  '#####.....#######.....',
] as const

const FROG_INTERIOR = frogInterior()
const STAR_BITMAP = ['....#....', '...###...', '#########', '.#######.', '..#####..', '..##.##..', '.##...##.'] as const
const FROG_OUTLINE = FROG_BITMAP.flatMap((row, y) =>
  [...row].flatMap((character, x) => {
    if (character !== '#') {
      return []
    }
    const point = { x: x - (FROG_BITMAP[0].length - 1) / 2, y: y - (FROG_BITMAP.length - 1) / 2 }
    return [point, { ...point, x: point.x + 0.5 }]
  })
)

export interface FrogPose {
  head: {
    y: number
    radiusX: number
    radiusY: number
  }
  hindY: number
}

export interface FrogTransform {
  x: number
  y: number
  scale: number
  rotation?: number
  flipX?: boolean
}

export const FROG_POSES = {
  crouch: {
    head: { y: -2.6, radiusX: 6.8, radiusY: 4.1 },
    hindY: 9.2,
  },
  takeoff: {
    head: { y: -6.1, radiusX: 6, radiusY: 4.1 },
    hindY: 13.1,
  },
  flight: {
    head: { y: -5.3, radiusX: 6.1, radiusY: 4.2 },
    hindY: 7.5,
  },
  squash: {
    head: { y: -0.5, radiusX: 7.4, radiusY: 3.3 },
    hindY: 8.3,
  },
  settled: {
    head: { y: -5.1, radiusX: 6.3, radiusY: 4.4 },
    hindY: 9.5,
  },
  reach: {
    head: { y: -5.2, radiusX: 6.2, radiusY: 4.2 },
    hindY: 8.6,
  },
} satisfies Record<string, FrogPose>

export function drawTongue(
  canvas: PixelSink,
  frog: { pose: FrogPose; transform: FrogTransform },
  anchor: Point,
  extension: number,
  release: number
): void {
  if (extension <= 0 || release >= 1) {
    return
  }
  const targetSide = clamp((anchor.x - frog.transform.x) / 4, -1, 1)
  const mouthSide = frog.transform.flipX ? -targetSide : targetSide
  const mouth = brandPoint({ x: mouthSide * 5.2, y: -3.6 }, frog.transform, frogDeformation(frog.pose))
  const attachedTip = interpolatePoint(mouth, anchor, extension)
  const tip = interpolatePoint(attachedTip, mouth, release)
  const bend = {
    x: lerp(mouth.x, tip.x, 0.56),
    y: lerp(mouth.y, tip.y, 0.56) + Math.sin(extension * Math.PI) * (1 - release) * 1.2,
  }
  fillCapsule(canvas, mouth, bend, 0.32, 'tongue', 88)
  fillCapsule(canvas, bend, tip, 0.32, 'tongue', 88)
  fillCircle(canvas, tip.x, tip.y, 0.58, 'tongue', 89)
}

export function hopState(from: Point, to: Point, progress: number): { pose: FrogPose; transform: FrogTransform } {
  const travel = easeInOutCubic(progress)
  const pose =
    progress < 0.18
      ? interpolatePose(FROG_POSES.crouch, FROG_POSES.takeoff, progress / 0.18)
      : progress < 0.76
        ? interpolatePose(FROG_POSES.takeoff, FROG_POSES.flight, (progress - 0.18) / 0.58)
        : interpolatePose(FROG_POSES.flight, FROG_POSES.squash, (progress - 0.76) / 0.24)
  return {
    pose,
    transform: {
      x: lerp(from.x, to.x, travel),
      y: lerp(from.y, to.y, travel) - Math.sin(travel * Math.PI) * 9,
      scale: 0.9,
      rotation: Math.sin(travel * Math.PI) * Math.sign(to.x - from.x) * 0.1,
    },
  }
}

export function frogFootOffset(transform: FrogTransform, pose: FrogPose): number {
  const origin = { ...transform, x: 0, y: 0 }
  const deformation = frogDeformation(pose)
  return Math.max(...FROG_OUTLINE.map((point) => brandPoint(point, origin, deformation).y))
}

export function drawPushingTongue(
  canvas: PixelSink,
  frog: { pose: FrogPose; transform: FrogTransform },
  anchor: Point,
  reach: number
): void {
  if (reach <= 0) {
    return
  }
  const mouth = brandPoint({ x: -5.2, y: -3.4 }, frog.transform, frogDeformation(frog.pose))
  const steps = Math.max(1, Math.ceil(reach * 64))
  let previous = mouth
  for (let step = 1; step <= steps; step++) {
    const t = (step / steps) * reach
    const travel = smoothStep(t)
    const point = {
      x: lerp(mouth.x, anchor.x, travel),
      y: lerp(mouth.y, anchor.y, travel) + Math.sin(travel * Math.PI) * 5 * frog.transform.scale,
    }
    fillCapsule(canvas, previous, point, 0.32, 'tongue', 88)
    previous = point
  }
  fillCircle(canvas, previous.x, previous.y, 0.58, 'tongue', 89)
}

export function drawArrivalRipple(canvas: PixelSink, x: number, y: number, local: number): void {
  const pulse = Math.sin(local * Math.PI)
  const radiusX = lerp(1.5, 8.5, easeOutCubic(local))
  const radiusY = lerp(0.8, 3.2, easeOutCubic(local))
  for (let index = 0; index < 20; index++) {
    const angle = (index / 20) * Math.PI * 2
    if (hash01(index * 41 + 17) > 1 - local + 0.22) {
      continue
    }
    fillCircle(
      canvas,
      x + Math.cos(angle) * radiusX,
      y + Math.sin(angle) * radiusY,
      0.24 + pulse * 0.14,
      index % 4 === 0 ? 'mint' : 'emerald',
      70
    )
  }
  const vertical = lerp(4.5, 0.5, easeOutCubic(local))
  fillCapsule(canvas, { x, y: y - vertical }, { x, y: y + vertical }, 0.3 + pulse * 0.18, 'lime', 71)
}

export function drawFrog(
  canvas: Canvas,
  transform: FrogTransform,
  pose: FrogPose,
  elapsedMs: number,
  reveal = 1
): void {
  const priority = 78
  const bodyReveal = Math.max(0, (reveal - 0.28) / 0.72)
  const target: PixelSink = bodyReveal >= 0.999 ? canvas : maskedPixels(canvas, bodyReveal, 73)
  const eyeReveal = reveal / 0.28
  const eyeTarget: PixelSink = eyeReveal >= 0.999 ? canvas : maskedPixels(canvas, eyeReveal, 174)
  const deformation = frogDeformation(pose)
  if (reveal > 0.68) {
    drawFrogAura(canvas, transform, elapsedMs, priority)
  }

  const centerX = (FROG_BITMAP[0].length - 1) / 2
  const centerY = (FROG_BITMAP.length - 1) / 2
  for (let row = 0; row < FROG_BITMAP.length; row++) {
    for (let column = 0; column < FROG_BITMAP[row]!.length; column++) {
      const key = `${column}:${row}`
      const points = [
        brandPoint({ x: column - centerX, y: row - centerY }, transform, deformation),
        brandPoint({ x: column - centerX + 0.5, y: row - centerY }, transform, deformation),
      ]
      const sink = row <= 4 ? eyeTarget : target
      if (canvas.theme !== 'minimal' && FROG_INTERIOR.has(key)) {
        for (const point of points) {
          sink.setPixel(point.x, point.y, frogFillColor(canvas, row, column), priority + 10)
        }
      }
      if (FROG_BITMAP[row]![column] === '#') {
        const spectreFace =
          canvas.theme === 'spectre' &&
          (((row === 2 || row === 3) && (column === 3 || column === 4 || column === 12 || column === 13)) ||
            (row === 6 && column === 7) ||
            (row === 7 && column >= 4 && column <= 6))
        for (const point of points) {
          sink.setPixel(point.x, point.y, spectreFace ? frogFillColor(canvas, row, column) : 'ink', priority + 20)
        }
      }
    }
  }
  if (reveal > 0.68) {
    drawThemeFace(canvas, transform, deformation, priority)
  }
}

function frogFillColor(canvas: Canvas, row: number, column: number): Color {
  if (canvas.theme === 'homeland') {
    const westernLand =
      (row >= 5 && row <= 11 && column >= 3 + Math.floor((row - 5) / 3) && column <= 9) ||
      (row >= 11 && row <= 17 && column >= 7 && column <= 11 - Math.floor((row - 11) / 3))
    const easternLand =
      (row >= 5 && row <= 11 && column >= 12 && column <= 18 - Math.floor((row - 5) / 4)) ||
      (row >= 10 && row <= 16 && column >= 12 + Math.floor((row - 10) / 3) && column <= 16)
    const island = row >= 16 && row <= 18 && column >= 17 && column <= 19
    if (westernLand || easternLand || island) {
      return (row + column) % 4 === 0 ? 'lime' : 'green'
    }
    return (row * 3 + column) % 7 === 0 ? 'cyan' : 'blue'
  }
  if (canvas.theme === 'circuit') {
    if ((column >= 12 && row >= 5 && row <= 13) || (column <= 8 && row >= 13)) {
      return (row + column) % 5 === 0 ? 'white' : 'green'
    }
    return (row * 7 + column * 3) % 23 === 0 ? 'white' : 'lime'
  }
  if (canvas.theme === 'merlin') {
    return column > 12 ? 'green' : 'lime'
  }
  if (
    canvas.theme === 'spectre' &&
    ((column === 4 && row >= 1 && row <= 3) || (row === 2 && column >= 12 && column <= 14))
  ) {
    return 'red'
  }
  return 'lime'
}

function drawThemeFace(canvas: Canvas, transform: FrogTransform, deformation: Point, priority: number): void {
  if (['green', 'minimal', 'kikker', 'spectre'].includes(canvas.theme)) {
    return
  }
  if (canvas.theme === 'merlin') {
    for (const star of [
      { x: -2, y: -1 },
      { x: 5, y: 5 },
    ]) {
      for (const [row, pixels] of STAR_BITMAP.entries()) {
        for (const [column, pixel] of [...pixels].entries()) {
          if (pixel === '#') {
            const point = brandPoint({ x: star.x + (column - 4) / 2, y: star.y + row - 3 }, transform, deformation)
            canvas.setPixel(point.x, point.y, 'yellow', priority + 32)
          }
        }
      }
    }
    const orb = brandPoint({ x: -6, y: 5.5 }, transform, deformation)
    const scale = transform.scale
    fillCircle(canvas, orb.x, orb.y, 2.6 * scale, 'ink', priority + 32)
    fillCircle(canvas, orb.x, orb.y, 2.1 * scale, 'blue', priority + 33)
    fillCircle(canvas, orb.x - 0.4 * scale, orb.y - 0.5 * scale, 1.55 * scale, 'cyan', priority + 34)
    fillCircle(canvas, orb.x - 0.8 * scale, orb.y - 1.1 * scale, 0.6 * scale, 'white', priority + 35)
  }
  for (const x of [-5.5, 3.5]) {
    const color = canvas.theme === 'circuit' ? (x < 0 ? 'cyan' : 'red') : 'white'
    const eye = brandPoint({ x, y: -7.5 }, transform, deformation)
    fillCircle(canvas, eye.x, eye.y, 0.58 * transform.scale, color, priority + 31)
  }
}

function drawFrogAura(canvas: Canvas, transform: FrogTransform, elapsedMs: number, priority: number): void {
  if (canvas.theme === 'green' || canvas.theme === 'minimal' || canvas.theme === 'kikker') {
    return
  }
  const center = { x: transform.x, y: transform.y / 2 }
  const tick = Math.floor(elapsedMs / 90)
  if (canvas.theme === 'circuit') {
    const bolts = [
      { from: { x: -8, y: -2 }, to: { x: -5, y: -0.6 } },
      { from: { x: 8, y: -3 }, to: { x: 5, y: -1 } },
      { from: { x: -7, y: 3 }, to: { x: -4.5, y: 1.4 } },
      { from: { x: 7, y: 3 }, to: { x: 4.5, y: 1.6 } },
    ]
    for (const [index, bolt] of bolts.entries()) {
      if ((tick + index * 2) % 5 === 0) {
        continue
      }
      canvas.line(
        { x: center.x + bolt.from.x, y: center.y + bolt.from.y },
        { x: center.x + bolt.to.x, y: center.y + bolt.to.y },
        index % 2 === 0 ? '╱' : '╲',
        index % 2 === 0 ? 'cyan' : 'red',
        priority + 4
      )
    }
    return
  }
  if (canvas.theme === 'merlin') {
    const stars = [
      { x: -10, y: -3 },
      { x: 11, y: 1 },
      { x: 8, y: -4 },
    ]
    for (const [index, star] of stars.entries()) {
      canvas.set(
        center.x + star.x * transform.scale,
        center.y + star.y * transform.scale,
        (tick + index) % 3 === 0 ? '✦' : '★',
        'yellow',
        priority + 4
      )
    }
    return
  }
  if (canvas.theme === 'spectre') {
    for (const side of [-1, 1]) {
      canvas.set(center.x + side * 10, center.y + Math.sin(tick * 0.2 + side), '·', 'red', priority + 4)
      canvas.set(center.x + side * 8, center.y + 3, '╴', 'forest', priority + 4)
    }
    return
  }
  for (let index = 0; index < 7; index++) {
    const angle = tick * 0.18 + (index * Math.PI * 2) / 7
    canvas.set(
      center.x + Math.cos(angle) * 9,
      center.y + Math.sin(angle) * 5,
      index % 3 === 0 ? '•' : '·',
      index % 3 === 0 ? 'lime' : index % 2 === 0 ? 'cyan' : 'mint',
      priority + 4
    )
  }
}

function frogDeformation(pose: FrogPose): Point {
  const top = pose.head.y - pose.head.radiusY
  return {
    x: pose.head.radiusX / 6.3,
    y: clamp((pose.hindY - top) / 19, 0.68, 1.12),
  }
}

function brandPoint(point: Point, transform: FrogTransform, deformation: Point): Point {
  const scaledX = point.x * transform.scale * deformation.x * (transform.flipX ? -1 : 1)
  const scaledY = point.y * transform.scale * deformation.y
  const cosine = Math.cos(transform.rotation ?? 0)
  const sine = Math.sin(transform.rotation ?? 0)
  return {
    x: transform.x + scaledX * cosine - scaledY * sine,
    y: transform.y + scaledX * sine + scaledY * cosine,
  }
}

function frogInterior(): Set<string> {
  const width = FROG_BITMAP[0].length
  const height = FROG_BITMAP.length
  const exterior = new Set<string>()
  const pending: Point[] = []
  for (let column = 0; column < width; column++) {
    pending.push({ x: column, y: 0 }, { x: column, y: height - 1 })
  }
  for (let row = 0; row < height; row++) {
    pending.push({ x: 0, y: row }, { x: width - 1, y: row })
  }
  while (pending.length > 0) {
    const point = pending.pop()!
    const key = `${point.x}:${point.y}`
    if (
      point.x < 0 ||
      point.x >= width ||
      point.y < 0 ||
      point.y >= height ||
      exterior.has(key) ||
      FROG_BITMAP[point.y]![point.x] === '#'
    ) {
      continue
    }
    exterior.add(key)
    pending.push(
      { x: point.x - 1, y: point.y },
      { x: point.x + 1, y: point.y },
      { x: point.x, y: point.y - 1 },
      { x: point.x, y: point.y + 1 }
    )
  }
  const interior = new Set<string>()
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const key = `${column}:${row}`
      if (FROG_BITMAP[row]![column] !== '#' && !exterior.has(key)) {
        interior.add(key)
      }
    }
  }
  return interior
}

export function interpolatePose(from: FrogPose, to: FrogPose, progress: number): FrogPose {
  const value = Math.min(1, progress)
  return {
    head: {
      radiusX: lerp(from.head.radiusX, to.head.radiusX, value),
      radiusY: lerp(from.head.radiusY, to.head.radiusY, value),
      y: lerp(from.head.y, to.head.y, value),
    },
    hindY: lerp(from.hindY, to.hindY, value),
  }
}

function interpolatePoint(from: Point, to: Point, progress: number): Point {
  return { x: lerp(from.x, to.x, progress), y: lerp(from.y, to.y, progress) }
}

export function fillEllipse(
  canvas: PixelSink,
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  color: Color,
  priority: number,
  angle = 0
): void {
  if (radiusX <= 0 || radiusY <= 0) {
    return
  }
  const extent = Math.ceil(Math.max(radiusX, radiusY))
  const cosine = Math.cos(angle)
  const sine = Math.sin(angle)
  for (let y = Math.floor(centerY - extent); y <= Math.ceil(centerY + extent); y++) {
    for (let x = Math.floor((centerX - extent) * 2) / 2; x <= Math.ceil(centerX + extent); x += 0.5) {
      const offsetX = x - centerX
      const offsetY = y - centerY
      const localX = offsetX * cosine + offsetY * sine
      const localY = -offsetX * sine + offsetY * cosine
      if ((localX * localX) / (radiusX * radiusX) + (localY * localY) / (radiusY * radiusY) <= 1) {
        canvas.setPixel(x, y, color, priority)
      }
    }
  }
}

export function fillCircle(
  canvas: PixelSink,
  centerX: number,
  centerY: number,
  radius: number,
  color: Color,
  priority: number
): void {
  fillEllipse(canvas, centerX, centerY, radius, radius, color, priority)
}

function fillCapsule(canvas: PixelSink, from: Point, to: Point, radius: number, color: Color, priority: number): void {
  const minimumX = Math.floor((Math.min(from.x, to.x) - radius) * 2) / 2
  const maximumX = Math.ceil(Math.max(from.x, to.x) + radius)
  const minimumY = Math.floor(Math.min(from.y, to.y) - radius)
  const maximumY = Math.ceil(Math.max(from.y, to.y) + radius)
  for (let y = minimumY; y <= maximumY; y++) {
    for (let x = minimumX; x <= maximumX; x += 0.5) {
      if (distanceToSegment({ x, y }, from, to) <= radius) {
        canvas.setPixel(x, y, color, priority)
      }
    }
  }
}

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const deltaX = to.x - from.x
  const deltaY = to.y - from.y
  const lengthSquared = deltaX * deltaX + deltaY * deltaY
  if (lengthSquared === 0) {
    return Math.hypot(point.x - from.x, point.y - from.y)
  }
  const progress = clamp(((point.x - from.x) * deltaX + (point.y - from.y) * deltaY) / lengthSquared)
  return Math.hypot(point.x - (from.x + deltaX * progress), point.y - (from.y + deltaY * progress))
}

function maskedPixels(canvas: PixelSink, reveal: number, seed: number): PixelSink {
  return {
    setPixel(x, y, color, priority): void {
      if (hash01(Math.round(x * 2) * 131 + Math.round(y) * 197 + seed * 17) <= reveal) {
        canvas.setPixel(x, y, color, priority)
      }
    },
  }
}

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value))
}

export function lerp(from: number, to: number, progress: number): number {
  return from + (to - from) * progress
}

export function easeOutCubic(value: number): number {
  return 1 - (1 - clamp(value)) ** 3
}

export function easeInOutCubic(value: number): number {
  const progress = clamp(value)
  return progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2
}

export function smoothStep(value: number): number {
  const progress = clamp(value)
  return progress * progress * (3 - 2 * progress)
}

export function hash01(value: number): number {
  const sine = Math.sin(value * 12.9898) * 43_758.5453
  return sine - Math.floor(sine)
}
