/**
 * Minimal, structurally valid media files for the `read` media checks.
 *
 * `harness-py/tests/tools/media_fixtures.py` builds the same bytes, so both SDKs are tested on identical files.
 */

import { Buffer } from 'node:buffer'
import { deflateSync } from 'node:zlib'

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

/** A bitwise reference CRC-32, independent of the implementation under test. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function u32be(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0)
  return b
}

function u16le(...values: number[]): Buffer {
  const b = Buffer.alloc(2 * values.length)
  values.forEach((v, i) => b.writeUInt16LE(v, 2 * i))
  return b
}

function u32le(...values: number[]): Buffer {
  const b = Buffer.alloc(4 * values.length)
  values.forEach((v, i) => b.writeUInt32LE(v >>> 0, 4 * i))
  return b
}

const latin1 = (s: string): Buffer => Buffer.from(s, 'latin1')

export function pngChunk(kind: string, body: Uint8Array): Buffer {
  const typeAndBody = Buffer.concat([latin1(kind), body])
  return Buffer.concat([u32be(body.length), typeAndBody, u32be(crc32(typeAndBody))])
}

/** A 1x1 RGB PNG. */
export function png(beforeIdat: Uint8Array = Buffer.alloc(0)): Buffer {
  const ihdr = pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]))
  // Python's zlib.compress at its default level, byte for byte.
  const idat = pngChunk('IDAT', deflateSync(Buffer.alloc(4), { level: 6 }))
  return Buffer.concat([latin1('\x89PNG\r\n\x1a\n'), ihdr, beforeIdat, idat, pngChunk('IEND', Buffer.alloc(0))])
}

export const PNG = png()
/** The IDAT chunk's type field. */
export const PNG_IDAT = PNG.indexOf('IDAT')

/** A 1x1 grayscale JPEG with `scans` scans under the `sof` frame marker. */
export function jpeg(sof = 0xc0, scans = 1): Buffer {
  const jfif = latin1('\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00')
  const frame = Buffer.concat([Buffer.from([0xff, sof]), latin1('\x00\x0b\x08\x00\x01\x00\x01\x01\x01\x11\x00')])
  const scan = latin1('\xff\xda\x00\x08\x01\x01\x00\x00\x3f\x00\xd2\xcf\x20\xff\x00\x14')
  return Buffer.concat([latin1('\xff\xd8'), jfif, frame, ...Array<Buffer>(scans).fill(scan), latin1('\xff\xd9')])
}

export const JPEG = jpeg()
export const PROGRESSIVE_JPEG = jpeg(0xc2, 2)

const GIF_1X1 = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64')
// Header and global color table, then a graphic control extension, then one image, then the trailer.
const GIF_HEADER = GIF_1X1.subarray(0, 19)
const GIF_FRAME = GIF_1X1.subarray(19, -1)

export function gif(frames = 1): Buffer {
  return Buffer.concat([GIF_HEADER, ...Array<Buffer>(frames).fill(GIF_FRAME), latin1(';')])
}

export const GIF = gif()
export const ANIMATED_GIF = gif(2)
const VP8L = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64').subarray(12)

export function riff(...chunks: Uint8Array[]): Buffer {
  const body = Buffer.concat([latin1('WEBP'), ...chunks])
  return Buffer.concat([latin1('RIFF'), u32le(body.length), body])
}

export function webpChunk(kind: string, body: Uint8Array): Buffer {
  return Buffer.concat([latin1(kind), u32le(body.length), body, Buffer.alloc(body.length & 1)])
}

export const WEBP = riff(VP8L)
const ANMF = webpChunk('ANMF', Buffer.concat([Buffer.alloc(16), VP8L]))
export const ANIMATED_WEBP = riff(
  webpChunk('VP8X', Buffer.concat([Buffer.from([2]), Buffer.alloc(9)])),
  webpChunk('ANIM', Buffer.alloc(6)),
  ANMF,
  ANMF
)

/** A one-revision PDF with an exact cross-reference table. */
export function pdf(...objects: string[]): Buffer {
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  const size = objects.length + 1
  out +=
    `xref\n0 ${size}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  return latin1(out + `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
}

export const PDF = pdf(
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>'
)
/** A linearized PDF cut off after its first-page trailer. */
export const PDF_LINEARIZED_CUT = latin1(
  '%PDF-1.7\n1 0 obj\n<< /Linearized 1 >>\nendobj\ntrailer\n<< /Root 2 0 R >>\nstartxref\n0\n%%EOF\n' +
    '2 0 obj\n<< /Type /Catalog'
)

/** A stored (uncompressed) zip archive with one small entry per name. */
export function zipArchive(...names: string[]): Buffer {
  const body = latin1('<x/>')
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const name of names) {
    const encoded = Buffer.from(name)
    const fields = Buffer.concat([
      u16le(20, 0, 0, 0, 0),
      u32le(crc32(body), body.length, body.length),
      u16le(encoded.length, 0),
    ])
    centrals.push(latin1('PK\x01\x02'), u16le(20), fields, u16le(0, 0, 0), u32le(0, offset), encoded)
    const local = Buffer.concat([latin1('PK\x03\x04'), fields, encoded, body])
    locals.push(local)
    offset += local.length
  }
  const central = Buffer.concat(centrals)
  const end = Buffer.concat([u16le(0, 0, names.length, names.length), u32le(central.length, offset), u16le(0)])
  return Buffer.concat([...locals, central, latin1('PK\x05\x06'), end])
}

export const DOCX = zipArchive('[Content_Types].xml', 'word/document.xml')
export const XLSX = zipArchive('[Content_Types].xml', 'xl/workbook.xml')
const NOSTREAM = 0xffffffff

export function oleEntry(name: string, kind = 2, child = NOSTREAM, right = NOSTREAM): Buffer {
  const encoded = Buffer.from(`${name}\0`, 'utf16le')
  const padded = Buffer.concat([encoded, Buffer.alloc(64 - encoded.length)])
  const fields = Buffer.concat([u16le(encoded.length), Buffer.from([kind, 1]), u32le(NOSTREAM, right, child)])
  return Buffer.concat([padded, fields, Buffer.alloc(48)])
}

/** A compound file: a header, one FAT sector, then one directory sector of a root and its `streams`. */
export function ole(streams: string[], directoryNext = 0xfffffffe): Buffer {
  const entries = [
    oleEntry('Root Entry', 5, 1),
    ...streams.map((name, i) => oleEntry(name, 2, NOSTREAM, i + 1 < streams.length ? i + 2 : NOSTREAM)),
  ]
  const header = Buffer.alloc(512)
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header)
  header.writeUInt16LE(9, 30)
  header.writeUInt32LE(1, 44)
  header.writeUInt32LE(1, 48)
  header.fill(0xff, 80)
  header.writeUInt32LE(0, 76)
  const fat = Buffer.alloc(512, 0xff)
  u32le(0xfffffffd, directoryNext, NOSTREAM).copy(fat)
  const directory = Buffer.alloc(512)
  Buffer.concat(entries).copy(directory)
  return Buffer.concat([header, fat, directory])
}

export const DOC = ole(['WordDocument'])
export const XLS = ole(['Workbook'])
export const HTML = latin1('<!DOCTYPE html>\n<html><title>404 Not Found</title>\n<h1>Not Found</h1></html>\n')
