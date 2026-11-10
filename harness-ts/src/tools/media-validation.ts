/**
 * Structural checks that a file really is the image or document `read` is about to send as media.
 *
 * A media block the provider cannot decode fails the request, and because the tool result stays in history, every
 * later request too. These checks catch truncated, corrupt, empty, and mislabeled files without decoding anything.
 * They reject a file only on positive evidence that it is broken, and are tuned to what Bedrock accepts: a JPEG cut
 * off mid-scan, a GIF without its trailer, or a PDF without `%%EOF` still renders there, so each passes here.
 *
 * @internal
 */

import { Buffer } from 'node:buffer'

import { logger } from '../logging.js'

type Family = 'Word' | 'Excel'
type Check = (data: Buffer) => string | undefined

const TRUNCATED = 'it is truncated'
const NO_IMAGE_DATA = 'it has no image data'
const JPEG_PROGRESSIVE: readonly number[] = [0xc2, 0xc6, 0xca, 0xce]
// An object header (`12 0 obj`), with whitespace as PDF defines it.
const PDF_OBJECT = /\d+[\0\t\n\f\r ]+\d+[\0\t\n\f\r ]+obj\b/
const ZIP_LOCAL = Buffer.from('PK\x03\x04', 'latin1')
const ZIP_CENTRAL = Buffer.from('PK\x01\x02', 'latin1')
const ZIP_END = Buffer.from('PK\x05\x06', 'latin1')
const OLE_SIGNATURE = Buffer.from('d0cf11e0a1b11ae1', 'hex')
// OLE2 FAT values at or above this mark a free sector or the end of a chain rather than a next sector.
const OLE_SPECIAL = 0xfffffffa
// Zip fields saturated to this defer to a zip64 record, which these checks do not read.
const ZIP64 = 0xffffffff
const ZIP_CORRUPT = 'its zip archive is corrupt or truncated'
// The part (OOXML) and root stream names (OLE2) that mark each Office family.
const OOXML_PARTS: Record<Family, string> = { Word: 'word/', Excel: 'xl/' }
const OLE_STREAMS: Record<Family, readonly string[]> = {
  Word: ['WordDocument'],
  Excel: ['Workbook', 'WORKBOOK', 'Book'],
}
const FAMILY_NAMES: Record<Family, string> = { Word: 'a Word document', Excel: 'an Excel workbook' }

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

/**
 * Why `data` is not a usable `format` file, or `undefined` if it is.
 *
 * An image's signature must already match `format`. A check that fails unexpectedly passes the file, so a gap in
 * these checks never blocks a file that worked before them.
 *
 * @internal
 */
export function mediaProblem(format: string, data: Uint8Array): string | undefined {
  try {
    return CHECKS[format]!(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
  } catch (error) {
    logger.warn(`mediaFormat=<${format}> | media validation failed, sending the file unchecked`, error)
    return undefined
  }
}

function startsWith(data: Buffer, prefix: Buffer, offset = 0): boolean {
  return offset >= 0 && data.subarray(offset, offset + prefix.length).equals(prefix)
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngProblem(data: Buffer): string | undefined {
  let pos = 8
  let hasData = false
  while (pos + 12 <= data.length) {
    const length = data.readUInt32BE(pos)
    const kind = data.toString('latin1', pos + 4, pos + 8)
    const end = pos + 12 + length
    if (end > data.length) return TRUNCATED
    if (pos === 8 && (kind !== 'IHDR' || length !== 13)) return 'its IHDR header is malformed'
    // Like libpng, only a critical chunk (uppercase first letter) must carry a matching checksum.
    if (!(data[pos + 4]! & 0x20) && crc32(data.subarray(pos + 4, end - 4)) !== data.readUInt32BE(end - 4)) {
      return 'a chunk checksum does not match'
    }
    hasData ||= kind === 'IDAT'
    if (kind === 'IEND') return hasData ? undefined : NO_IMAGE_DATA
    pos = end
  }
  return TRUNCATED
}

function jpegProblem(data: Buffer): string | undefined {
  // Decoders render a baseline JPEG cut off inside its scan, and a progressive one cut after its first scan.
  let pos = 2
  let frame: number | undefined
  let hasScan = false
  while (pos + 4 <= data.length) {
    if (data[pos] !== 0xff) return 'its marker segments are malformed'
    const marker = data[pos + 1]!
    if (marker === 0xff) {
      pos += 1 // fill byte
      continue
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      pos += 2 // standalone markers carry no length
      continue
    }
    if (marker === 0xd9) break
    let end = pos + 2 + data.readUInt16BE(pos + 2)
    if (end > data.length) return TRUNCATED
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) frame = marker
    if (marker === 0xda) {
      const scanEnd = jpegScanEnd(data, end)
      const whole = scanEnd !== undefined || !JPEG_PROGRESSIVE.includes(frame ?? 0)
      hasScan ||= frame !== undefined && end < data.length && whole
      end = scanEnd ?? data.length
    }
    pos = end
  }
  return hasScan ? undefined : NO_IMAGE_DATA
}

/** The marker that ends a scan's entropy-coded data: 0xFF not followed by a stuffed zero, a restart, or fill. */
function jpegScanEnd(data: Buffer, from: number): number | undefined {
  for (let pos = data.indexOf(0xff, from); pos >= 0 && pos + 1 < data.length; pos = data.indexOf(0xff, pos + 1)) {
    const next = data[pos + 1]!
    if (next !== 0x00 && next !== 0xff && (next < 0xd0 || next > 0xd7)) return pos
  }
  return undefined
}

function gifProblem(data: Buffer): string | undefined {
  if (data.length < 13) return TRUNCATED
  let pos = 13 + gifColorTable(data[10]!)
  let images = 0
  // A missing trailer is fine, and so is a cut after the first frame: decoders show the frames before it.
  while (pos < data.length && data[pos] !== 0x3b) {
    const introducer = data[pos]
    let end: number | undefined
    if (introducer === 0x21) end = gifSkipSubBlocks(data, pos + 2)
    else if (introducer === 0x2c) end = gifImageEnd(data, pos)
    else return 'its block structure is malformed'
    if (end === undefined) return images ? undefined : TRUNCATED
    if (introducer === 0x2c) images += 1
    pos = end
  }
  return images ? undefined : NO_IMAGE_DATA
}

function gifImageEnd(data: Buffer, pos: number): number | undefined {
  if (pos + 10 > data.length) return undefined
  return gifSkipSubBlocks(data, pos + 11 + gifColorTable(data[pos + 9]!))
}

function gifColorTable(flags: number): number {
  return flags & 0x80 ? 3 << ((flags & 7) + 1) : 0
}

function gifSkipSubBlocks(data: Buffer, from: number): number | undefined {
  let pos = from
  while (pos < data.length) {
    const size = data[pos]!
    pos += 1 + size
    if (size === 0) return pos
  }
  return undefined
}

function webpProblem(data: Buffer): string | undefined {
  const end = Math.min(data.length, data.readUInt32LE(4) + 8)
  let pos = 12
  let hasImage = false
  while (pos + 8 <= end) {
    const kind = data.toString('latin1', pos, pos + 4)
    const size = data.readUInt32LE(pos + 4)
    // Like a GIF, an animation cut after its first complete frame still shows.
    if (pos + 8 + size > data.length) return hasImage ? undefined : TRUNCATED
    hasImage ||= ['VP8 ', 'VP8L', 'ANMF'].includes(kind)
    pos += 8 + size + (size & 1)
  }
  return hasImage ? undefined : NO_IMAGE_DATA
}

function pdfProblem(data: Buffer): string | undefined {
  // Readers allow junk before the header and after the trailer. A truncated PDF loses its final trailer; a
  // linearized one still has its first-page trailer near the start, so no object may follow the last trailer.
  const start = data.subarray(0, 1024).indexOf('%PDF-')
  if (start < 0) return 'it has no %PDF- header'
  const trailer = data.lastIndexOf('startxref')
  if (trailer > start && !pdfObjectFollows(data, trailer)) return undefined
  return 'it does not end with a cross-reference trailer, so it is likely truncated'
}

function pdfObjectFollows(data: Buffer, from: number): boolean {
  // Decode the tail only when it might hold an object, so a usual read copies nothing.
  return data.indexOf('obj', from) >= 0 && PDF_OBJECT.test(data.toString('latin1', from))
}

function officeProblem(data: Buffer, family: Family): string | undefined {
  // The container does not have to match the extension (a docx named .doc renders), only the family.
  if (startsWith(data, ZIP_LOCAL)) return ooxmlProblem(data, family)
  if (startsWith(data, OLE_SIGNATURE)) return oleProblem(data, family)
  return `it is not ${FAMILY_NAMES[family]}`
}

function ooxmlProblem(data: Buffer, family: Family): string | undefined {
  // The end-of-central-directory record sits in the last 22 bytes plus an archive comment of up to 64 KiB.
  const searchFrom = Math.max(0, data.length - 65557)
  const found = data.subarray(searchFrom).lastIndexOf(ZIP_END)
  const eocd = found < 0 ? -1 : searchFrom + found
  if (eocd < 0 || eocd + 22 > data.length) return ZIP_CORRUPT
  const offset = data.readUInt32LE(eocd + 16)
  if (offset === ZIP64) return undefined
  const names = zipNames(data, offset, data.readUInt16LE(eocd + 10))
  if (names === undefined) return ZIP_CORRUPT
  if (!names.includes('[Content_Types].xml')) return 'it is a zip archive, not an Office document'
  if (names.some((name) => name.startsWith(OOXML_PARTS[family]))) return undefined
  return `it is not ${FAMILY_NAMES[family]}`
}

/** The names of the `count` central-directory entries at `from`, or `undefined` if one lies outside `data`. */
function zipNames(data: Buffer, from: number, count: number): string[] | undefined {
  const names: string[] = []
  let pos = from
  for (let entry = 0; entry < count; entry++) {
    if (!startsWith(data, ZIP_CENTRAL, pos) || pos + 46 > data.length) return undefined
    const compressed = data.readUInt32LE(pos + 20)
    const nameLength = data.readUInt16LE(pos + 28)
    const local = data.readUInt32LE(pos + 42)
    if (!startsWith(data, ZIP_LOCAL, local) || local + 30 > data.length) return undefined
    const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28)
    if (compressed !== ZIP64 && start + compressed > data.length) return undefined
    names.push(data.toString('latin1', pos + 46, pos + 46 + nameLength))
    pos += 46 + nameLength + data.readUInt16LE(pos + 30) + data.readUInt16LE(pos + 32)
  }
  return names
}

function oleProblem(data: Buffer, family: Family): string | undefined {
  if (data.length < 512) return TRUNCATED
  const shift = data.readUInt16LE(30)
  if (shift !== 9 && shift !== 12) return 'its header is malformed'
  const sector = 1 << shift
  const sectors = Math.ceil(data.length / sector) - 1
  const fatSectors = Array.from({ length: Math.min(data.readUInt32LE(44), 109) }, (_, i) =>
    data.readUInt32LE(76 + 4 * i)
  )
  if ([...fatSectors, data.readUInt32LE(48)].some((s) => s >= sectors)) return TRUNCATED
  // A truncated file still has FAT chains pointing at sectors past its end.
  if (fatSectors.some((s) => oleFatReaches(data.subarray((s + 1) * sector, (s + 2) * sector), sectors))) {
    return TRUNCATED
  }
  if (OLE_STREAMS[family].some((name) => oleHasEntry(data, name))) return undefined
  return `it is not ${FAMILY_NAMES[family]}`
}

/** Whether a FAT sector chains to a sector at or past `sectors`. */
function oleFatReaches(fat: Buffer, sectors: number): boolean {
  for (let pos = 0; pos + 4 <= fat.length; pos += 4) {
    const following = fat.readUInt32LE(pos)
    if (following >= sectors && following < OLE_SPECIAL) return true
  }
  return false
}

/** Whether a directory entry named exactly `name` exists, at any depth. */
function oleHasEntry(data: Buffer, name: string): boolean {
  // Directory entries are 128-byte aligned: a UTF-16 name, then its byte length (with terminator) at offset 64.
  const encoded = Buffer.from(`${name}\0`, 'utf16le')
  for (let pos = data.indexOf(encoded); pos >= 0; pos = data.indexOf(encoded, pos + 1)) {
    if (pos % 128 === 0 && pos + 66 <= data.length && data.readUInt16LE(pos + 64) === encoded.length) return true
  }
  return false
}

/** @internal Exported for tests. */
export const CHECKS: Record<string, Check> = {
  png: pngProblem,
  jpeg: jpegProblem,
  gif: gifProblem,
  webp: webpProblem,
  pdf: pdfProblem,
  doc: (data) => officeProblem(data, 'Word'),
  docx: (data) => officeProblem(data, 'Word'),
  xls: (data) => officeProblem(data, 'Excel'),
  xlsx: (data) => officeProblem(data, 'Excel'),
}
