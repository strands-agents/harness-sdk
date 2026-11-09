import type { ResolvedColorMode } from '../chat/types.js'

function backgroundMode(red: number, green: number, blue: number): ResolvedColorMode {
  const linear = [red, green, blue].map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  )
  const luminance = linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722
  return luminance > 0.179 ? 'light' : 'dark'
}

export function detectColorMode(environment: NodeJS.ProcessEnv = process.env): ResolvedColorMode {
  const background = environment.COLORFGBG?.split(';').at(-1)?.trim()
  if (!background || !/^\d{1,3}$/.test(background)) {
    return 'dark'
  }
  const index = Number(background)
  if (index > 255) {
    return 'dark'
  }
  if (index < 16) {
    const colors = [
      '#000000',
      '#800000',
      '#008000',
      '#808000',
      '#000080',
      '#800080',
      '#008080',
      '#c0c0c0',
      '#808080',
      '#ff0000',
      '#00ff00',
      '#ffff00',
      '#0000ff',
      '#ff00ff',
      '#00ffff',
      '#ffffff',
    ]
    const color = colors[index]!
    return backgroundMode(
      Number.parseInt(color.slice(1, 3), 16) / 255,
      Number.parseInt(color.slice(3, 5), 16) / 255,
      Number.parseInt(color.slice(5, 7), 16) / 255
    )
  }
  if (index >= 232) {
    const gray = (8 + (index - 232) * 10) / 255
    return backgroundMode(gray, gray, gray)
  }
  const cube = index - 16
  const channels = [Math.floor(cube / 36), Math.floor(cube / 6) % 6, cube % 6].map((value) =>
    value === 0 ? 0 : (55 + value * 40) / 255
  )
  return backgroundMode(channels[0]!, channels[1]!, channels[2]!)
}
