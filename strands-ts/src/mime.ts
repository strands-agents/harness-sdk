/**
 * MIME type utilities for media format detection and conversion.
 *
 * Provides bidirectional mapping between media formats and MIME types.
 */

export const IMAGE_FORMATS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const

export type AudioFormat =
  | 'mp3'
  | 'opus'
  | 'wav'
  | 'aac'
  | 'flac'
  | 'mp4'
  | 'ogg'
  | 'mkv'
  | 'mka'
  | 'x-aac'
  | 'm4a'
  | 'mpeg'
  | 'mpga'
  | 'pcm'
  | 'webm'

export type ImageFormat = (typeof IMAGE_FORMATS)[number]

export type VideoFormat = 'mkv' | 'mov' | 'mp4' | 'webm' | 'flv' | 'mpeg' | 'mpg' | 'wmv' | '3gp'

export type DocumentFormat = 'pdf' | 'csv' | 'doc' | 'docx' | 'xls' | 'xlsx' | 'html' | 'txt' | 'md' | 'json' | 'xml'

export type MediaFormat = DocumentFormat | ImageFormat | VideoFormat

const TO_MIME_TYPE: Record<MediaFormat, string> = {
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  // Videos
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  webm: 'video/webm',
  flv: 'video/x-flv',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
  wmv: 'video/x-ms-wmv',
  '3gp': 'video/3gpp',
  // Documents
  pdf: 'application/pdf',
  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html',
  txt: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
}

const TO_MEDIA_FORMAT: Record<string, MediaFormat> = {
  // Images
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  // Videos
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-flv': 'flv',
  'video/mpeg': 'mpeg',
  'video/x-ms-wmv': 'wmv',
  'video/3gpp': '3gp',
  // Documents
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/xml': 'xml',
}

/**
 * Convert a media format to its MIME type.
 *
 * @param format - Media format (e.g., 'png', 'pdf')
 * @returns MIME type string or undefined if not a known format
 */
export function toMimeType(format: string): string | undefined {
  return TO_MIME_TYPE[format.toLowerCase() as MediaFormat]
}

/**
 * Convert a MIME type to its canonical media format.
 *
 * @param mimeType - MIME type string (e.g., 'image/png', 'application/pdf')
 * @returns Media format or undefined if not a known MIME type
 */
export function toMediaFormat(mimeType: string): MediaFormat | undefined {
  return TO_MEDIA_FORMAT[mimeType.toLowerCase()]
}
