/**
 * Structural checks that a file really is the image or document its extension claims.
 *
 * A malformed media block makes Bedrock reject the request, and because the tool result stays in history,
 * every later request too. These checks catch truncated, corrupt, empty, and mislabeled files without a
 * decoding dependency, and are tuned to what Bedrock accepts: e.g. a JPEG missing its end marker or a PDF
 * missing `%%EOF` still renders there, so they pass here. Each returns `undefined` for a usable file, else why not.
 */

import { Buffer } from 'node:buffer'
import * as zlib from 'node:zlib'

import type { ImageFormat } from '@strands-agents/sdk'

const TRUNCATED = 'it is truncated'
const PDF_OBJECT = /\d+\s+\d+\s+obj\b/
const PDF_TRUNCATED = 'it does not end with a cross-reference trailer, so it is likely truncated'
// Deep checks stop after inflating this much, so a compression bomb costs bounded time and memory; what is
// left is accepted on structure alone, as before these checks existed.
const INFLATE_BUDGET = 64 << 20
const ZIP_CORRUPT = 'its zip archive is corrupt or truncated'
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]
const OLE_SPECIAL = 0xfffffffa
const OLE_EXCEL_STREAMS = ['Workbook', 'WORKBOOK', 'Book']
const DOCUMENT_FAMILY: Record<string, Family> = { doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel' }

type Family = 'Word' | 'Excel'
type FamilyResult = [Family | undefined, string | undefined]

/** Why `data` (whose signature already matched `format`) is not a usable image, if it is not. */
export function imageProblem(data: Uint8Array, format: ImageFormat): string | undefined {
  if (format === 'png') return pngProblem(data)
  if (format === 'jpeg') return jpegProblem(data)
  return format === 'gif' ? gifProblem(data) : webpProblem(data)
}

/** Why `data` is not a usable `format` document, if it is not. */
export function documentProblem(data: Uint8Array, format: string): string | undefined {
  if (format === 'pdf') return pdfProblem(data)
  let family: Family | undefined
  let problem: string | undefined
  if (startsWithBytes(data, [0x50, 0x4b, 0x03, 0x04])) [family, problem] = ooxmlFamily(data)
  else if (startsWithBytes(data, OLE_SIGNATURE)) [family, problem] = oleFamily(data)
  else return 'it is not a Word or Excel file'
  if (problem === undefined && family !== DOCUMENT_FAMILY[format]) {
    problem = family ? `it is ${family === 'Excel' ? 'an' : 'a'} ${family} file` : 'it is not Word or Excel'
  }
  return problem
}

function view(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength)
}

function startsWithBytes(data: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((byte, i) => data[i] === byte)
}

function ascii(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('latin1')
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

// zlib.crc32 is native from Node 22.2; the package still supports 22.0.
const crc32 = 'crc32' in zlib ? (data: Uint8Array): number => zlib.crc32(data) : jsCrc32

/** @internal Exported for tests. */
export function jsCrc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngProblem(data: Uint8Array): string | undefined {
  const dv = view(data)
  const idat: Uint8Array[] = []
  let pos = 8
  let expected = 0
  while (pos + 12 <= data.length) {
    const length = dv.getUint32(pos)
    const kind = ascii(data.subarray(pos + 4, pos + 8))
    if (pos + 12 + length > data.length) return TRUNCATED
    const typeAndBody = data.subarray(pos + 4, pos + 8 + length)
    if (pos === 8) {
      const ihdr = kind === 'IHDR' && length === 13 ? pngPixelBytes(view(typeAndBody.subarray(4))) : undefined
      if (ihdr === undefined) return 'its IHDR header is malformed'
      expected = ihdr
    }
    // Bedrock tolerates a bad checksum on an ancillary chunk (lowercase first letter), like libpng.
    if (!(data[pos + 4]! & 0x20) && crc32(typeAndBody) !== dv.getUint32(pos + 8 + length)) {
      return 'a chunk checksum does not match'
    }
    if (kind === 'IDAT') idat.push(typeAndBody.subarray(4))
    if (kind === 'IEND') return pngDataProblem(Buffer.concat(idat), expected)
    pos += 12 + length
  }
  return TRUNCATED
}

function pngDataProblem(stream: Uint8Array, expected: number): string | undefined {
  try {
    const inflated = zlib.inflateSync(stream, { maxOutputLength: INFLATE_BUDGET })
    return inflated.length >= expected ? undefined : 'its image data is incomplete'
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ERR_BUFFER_TOO_LARGE') return undefined
    return code === 'Z_BUF_ERROR' ? 'its image data is incomplete' : 'its image data is corrupt'
  }
}

function pngPixelBytes(ihdr: DataView): number | undefined {
  const [width, height, depth, colorType, interlace] = [
    ihdr.getUint32(0),
    ihdr.getUint32(4),
    ihdr.getUint8(8),
    ihdr.getUint8(9),
    ihdr.getUint8(12),
  ]
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colorType]
  if (channels === undefined || !width || !height) return undefined
  const adam7 = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
  ]
  let total = 0
  for (const [x0, y0, dx, dy] of interlace ? adam7 : [[0, 0, 1, 1]]) {
    const columns = Math.ceil((width - x0!) / dx!)
    const rows = Math.ceil((height - y0!) / dy!)
    if (columns > 0 && rows > 0) total += rows * (1 + Math.floor((columns * channels * depth + 7) / 8))
  }
  return total
}

function jpegProblem(data: Uint8Array): string | undefined {
  // Bedrock decodes a JPEG cut off mid-scan, so only the headers up to the first scan must be intact.
  const dv = view(data)
  let pos = 2
  let hasFrame = false
  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xff) return 'its marker segments are malformed'
    const marker = data[pos + 1]!
    if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      pos += marker === 0xff ? 1 : 2
      continue
    }
    if (marker === 0xd9) break
    const end = pos + 2 + dv.getUint16(pos + 2)
    if (end > data.length) return TRUNCATED
    hasFrame ||= marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (marker === 0xda) return hasFrame && end < data.length ? undefined : 'it has no image data'
    pos = end
  }
  return 'it has no image data'
}

function gifProblem(data: Uint8Array): string | undefined {
  const skipSubBlocks = (from: number): number | undefined => {
    let pos = from
    while (pos < data.length) {
      const size = data[pos]!
      pos += 1 + size
      if (size === 0) return pos
    }
    return undefined
  }
  const colorTable = (flags: number): number => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0)

  if (data.length < 13) return TRUNCATED
  let pos: number | undefined = 13 + colorTable(data[10]!)
  let images = 0
  // A missing trailer is fine (Bedrock accepts it); running out of data inside a block is not.
  while (pos !== undefined && pos < data.length && data[pos] !== 0x3b) {
    if (data[pos] === 0x21) {
      pos = skipSubBlocks(pos + 2)
    } else if (data[pos] === 0x2c) {
      pos = pos + 10 <= data.length ? skipSubBlocks(pos + 11 + colorTable(data[pos + 9]!)) : undefined
      images += 1
    } else {
      return 'its block structure is malformed'
    }
  }
  if (pos === undefined) return TRUNCATED
  return images ? undefined : 'it has no image data'
}

function webpProblem(data: Uint8Array): string | undefined {
  const dv = view(data)
  const end = Math.min(data.length, dv.getUint32(4, true) + 8)
  let pos = 12
  let hasImage = false
  while (pos + 8 <= end) {
    const kind = ascii(data.subarray(pos, pos + 4))
    const size = dv.getUint32(pos + 4, true)
    if (pos + 8 + size > data.length) return TRUNCATED
    hasImage ||= ['VP8 ', 'VP8L', 'ANMF'].includes(kind)
    pos += 8 + size + (size & 1)
  }
  return hasImage ? undefined : 'it has no image data'
}

function pdfProblem(data: Uint8Array): string | undefined {
  // Readers allow junk before the header and after the trailer. A truncated PDF loses its final trailer; a
  // linearized one still has its first-page trailer near the start, so no object may follow the last trailer.
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const start = buffer.subarray(0, 1024).indexOf('%PDF-')
  if (start < 0) return 'it has no %PDF- header'
  const trailer = buffer.lastIndexOf('startxref')
  if (trailer <= start) return PDF_TRUNCATED
  // Decode the tail only when it might hold an object, so a usual read copies nothing.
  if (buffer.indexOf('obj', trailer) < 0) return undefined
  return PDF_OBJECT.test(buffer.subarray(trailer).toString('latin1')) ? PDF_TRUNCATED : undefined
}

function ooxmlFamily(data: Uint8Array): FamilyResult {
  const dv = view(data)
  let eocd = data.length - 22
  while (eocd >= Math.max(0, data.length - 65557) && dv.getUint32(eocd, true) !== 0x06054b50) eocd--
  if (eocd < 0 || eocd < data.length - 65557) return [undefined, ZIP_CORRUPT]
  const names: string[] = []
  let budget = INFLATE_BUDGET
  let pos = dv.getUint32(eocd + 16, true)
  for (let entry = dv.getUint16(eocd + 10, true); entry > 0; entry--) {
    const parsed = zipEntry(data, dv, pos, budget)
    if (!parsed) return [undefined, ZIP_CORRUPT]
    names.push(parsed.name)
    budget -= parsed.inflated
    pos = parsed.next
  }
  if (!names.includes('[Content_Types].xml')) return [undefined, 'it is a zip archive, not an Office document']
  if (names.some((name) => name.startsWith('word/'))) return ['Word', undefined]
  return [names.some((name) => name.startsWith('xl/')) ? 'Excel' : undefined, undefined]
}

interface ZipEntry {
  name: string
  /** Offset of the next central-directory entry. */
  next: number
  /** Bytes inflated to check the CRC; 0 when the entry is past the budget and taken on structure alone. */
  inflated: number
}

/** The central-directory entry at `pos`, or `undefined` if it or its local entry is corrupt. */
function zipEntry(data: Uint8Array, dv: DataView, pos: number, budget: number): ZipEntry | undefined {
  if (pos + 46 > data.length || dv.getUint32(pos, true) !== 0x02014b50) return undefined
  const method = dv.getUint16(pos + 10, true)
  const [crc, compressed, size] = [
    dv.getUint32(pos + 16, true),
    dv.getUint32(pos + 20, true),
    dv.getUint32(pos + 24, true),
  ]
  const nameLength = dv.getUint16(pos + 28, true)
  const local = dv.getUint32(pos + 42, true)
  if (local + 30 > data.length || dv.getUint32(local, true) !== 0x04034b50) return undefined
  const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true)
  if (start + compressed > data.length || (method !== 0 && method !== 8)) return undefined
  const name = Buffer.from(data.subarray(pos + 46, pos + 46 + nameLength)).toString('utf8')
  const next = pos + 46 + nameLength + dv.getUint16(pos + 30, true) + dv.getUint16(pos + 32, true)
  if (size > budget) return { name, next, inflated: 0 }
  const body = data.subarray(start, start + compressed)
  try {
    const content = method === 0 ? body : zlib.inflateRawSync(body, { maxOutputLength: Math.max(size, 1) })
    return content.length === size && crc32(content) === crc ? { name, next, inflated: size } : undefined
  } catch {
    return undefined
  }
}

function oleFamily(data: Uint8Array): FamilyResult {
  if (data.length < 512) return [undefined, TRUNCATED]
  const dv = view(data)
  const shift = dv.getUint16(30, true)
  if (shift !== 9 && shift !== 12) return [undefined, 'its header is malformed']
  const sector = 1 << shift
  const sectors = Math.ceil(data.length / sector) - 1
  const fatSectors = Array.from({ length: Math.min(dv.getUint32(44, true), 109) }, (_, i) =>
    dv.getUint32(76 + 4 * i, true)
  )
  const directory = dv.getUint32(48, true)
  if ([...fatSectors, directory].some((s) => s >= sectors)) return [undefined, TRUNCATED]
  const fatBytes = Buffer.concat(fatSectors.map((s) => data.subarray((s + 1) * sector, (s + 2) * sector)))
  const fat = Array.from({ length: Math.floor(fatBytes.length / 4) }, (_, i) => fatBytes.readUInt32LE(4 * i))
  // A truncated file still has FAT chains pointing at sectors past its end.
  if (fat.some((following) => following >= sectors && following < OLE_SPECIAL)) return [undefined, TRUNCATED]
  // Like Bedrock, look only at the root storage (embedded objects live below it), and Excel wins.
  const names = oleRootNames(data, sector, fat, directory)
  if (OLE_EXCEL_STREAMS.some((name) => names.has(name))) return ['Excel', undefined]
  return [names.has('WordDocument') ? 'Word' : undefined, undefined]
}

function oleRootNames(data: Uint8Array, sector: number, fat: number[], directory: number): Set<string> {
  const chain = new Set<number>()
  for (let s = directory; s < fat.length && !chain.has(s); s = fat[s]!) chain.add(s)
  const entries = Buffer.concat([...chain].map((s) => data.subarray((s + 1) * sector, (s + 2) * sector)))
  const count = Math.floor(entries.length / 128)
  // The root's children form a binary tree of sibling links, starting at the root entry's child.
  const names = new Set<string>()
  const seen = new Set<number>()
  const pending = count ? [entries.readUInt32LE(76)] : []
  while (pending.length) {
    const index = pending.pop()!
    if (index >= count || seen.has(index)) continue
    seen.add(index)
    const entry = entries.subarray(index * 128, (index + 1) * 128)
    const length = Math.min(entry.readUInt16LE(64), 64)
    names.add(entry.subarray(0, Math.max(length - 2, 0) & ~1).toString('utf16le'))
    pending.push(entry.readUInt32LE(68), entry.readUInt32LE(72))
  }
  return names
}
