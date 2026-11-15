import { describe, it, expect } from 'vitest'
import { toMimeType, toMediaFormat, toAudioMimeType, toAudioMediaFormat } from '../mime.js'

describe('toMimeType', () => {
  it.each([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
    ['gif', 'image/gif'],
    ['webp', 'image/webp'],
    ['mkv', 'video/x-matroska'],
    ['mov', 'video/quicktime'],
    ['mp4', 'video/mp4'],
    ['webm', 'video/webm'],
    ['flv', 'video/x-flv'],
    ['mpeg', 'video/mpeg'],
    ['mpg', 'video/mpeg'],
    ['wmv', 'video/x-ms-wmv'],
    ['3gp', 'video/3gpp'],
    ['pdf', 'application/pdf'],
    ['csv', 'text/csv'],
    ['doc', 'application/msword'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['xls', 'application/vnd.ms-excel'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['html', 'text/html'],
    ['txt', 'text/plain'],
    ['md', 'text/markdown'],
    ['json', 'application/json'],
    ['xml', 'application/xml'],
  ])('converts %s to %s', (mediaFormat, mimeType) => {
    expect(toMimeType(mediaFormat)).toBe(mimeType)
  })

  it('is case-insensitive', () => {
    expect(toMimeType('PNG')).toBe('image/png')
    expect(toMimeType('Mp4')).toBe('video/mp4')
    expect(toMimeType('PDF')).toBe('application/pdf')
  })

  it('returns undefined for unknown formats', () => {
    expect(toMimeType('unknown')).toBeUndefined()
    expect(toMimeType('bmp')).toBeUndefined()
    expect(toMimeType('')).toBeUndefined()
  })
})

describe('toMediaFormat', () => {
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpeg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
    ['video/x-matroska', 'mkv'],
    ['video/quicktime', 'mov'],
    ['video/mp4', 'mp4'],
    ['video/webm', 'webm'],
    ['video/x-flv', 'flv'],
    ['video/mpeg', 'mpeg'],
    ['video/x-ms-wmv', 'wmv'],
    ['video/3gpp', '3gp'],
    ['application/pdf', 'pdf'],
    ['text/csv', 'csv'],
    ['application/msword', 'doc'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
    ['application/vnd.ms-excel', 'xls'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
    ['text/html', 'html'],
    ['text/plain', 'txt'],
    ['text/markdown', 'md'],
    ['application/json', 'json'],
    ['application/xml', 'xml'],
  ])('converts %s to %s', (mimeType, mediaFormat) => {
    expect(toMediaFormat(mimeType)).toBe(mediaFormat)
  })

  it('is case-insensitive', () => {
    expect(toMediaFormat('IMAGE/PNG')).toBe('png')
    expect(toMediaFormat('Video/Mp4')).toBe('mp4')
    expect(toMediaFormat('Application/PDF')).toBe('pdf')
  })

  it('returns undefined for unknown MIME types', () => {
    expect(toMediaFormat('image/bmp')).toBeUndefined()
    expect(toMediaFormat('application/octet-stream')).toBeUndefined()
    expect(toMediaFormat('')).toBeUndefined()
  })
})

describe('audio MIME conversions', () => {
  const audioFormats = [
    ['mp3', 'audio/mpeg'],
    ['opus', 'audio/opus'],
    ['wav', 'audio/wav'],
    ['aac', 'audio/aac'],
    ['flac', 'audio/flac'],
    ['mp4', 'audio/mp4'],
    ['ogg', 'audio/ogg'],
    ['mkv', 'audio/x-matroska'],
    ['mka', 'audio/x-matroska'],
    ['x-aac', 'audio/x-aac'],
    ['m4a', 'audio/mp4'],
    ['mpeg', 'audio/mpeg'],
    ['mpga', 'audio/mpeg'],
    ['pcm', 'audio/pcm'],
    ['webm', 'audio/webm'],
  ] as const

  it.each(audioFormats)('converts %s to %s', (audioFormat, mimeType) => {
    expect(toAudioMimeType(audioFormat)).toBe(mimeType)
  })

  it.each([
    ['audio/mpeg', 'mp3'],
    ['audio/opus', 'opus'],
    ['audio/wav', 'wav'],
    ['audio/aac', 'aac'],
    ['audio/flac', 'flac'],
    ['audio/mp4', 'mp4'],
    ['audio/ogg', 'ogg'],
    ['audio/x-matroska', 'mkv'],
    ['audio/x-aac', 'x-aac'],
    ['audio/pcm', 'pcm'],
    ['audio/webm', 'webm'],
  ])('converts %s to %s', (mimeType, audioFormat) => {
    expect(toAudioMediaFormat(mimeType)).toBe(audioFormat)
  })

  it('is case-insensitive and returns undefined for unknown MIME types', () => {
    expect(toAudioMediaFormat('Audio/WAV')).toBe('wav')
    expect(toAudioMediaFormat('audio/unknown')).toBeUndefined()
  })
})
