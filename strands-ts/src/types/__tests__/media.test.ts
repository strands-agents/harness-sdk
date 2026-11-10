import { describe, it, expect } from 'vitest'
import {
  S3Location,
  AudioBlock,
  ImageBlock,
  VideoBlock,
  DocumentBlock,
  encodeBase64,
  decodeBase64,
  type AudioBlockData,
  type ImageBlockData,
  type VideoBlockData,
  type DocumentBlockData,
} from '../media.js'
import { TextBlock } from '../messages.js'

describe('S3Location', () => {
  it('creates instance with uri only', () => {
    const location = new S3Location({
      uri: 's3://my-bucket/image.jpg',
    })
    expect(location).toEqual({
      type: 's3',
      uri: 's3://my-bucket/image.jpg',
    })
  })

  it('creates instance with uri and bucketOwner', () => {
    const location = new S3Location({
      uri: 's3://my-bucket/image.jpg',
      bucketOwner: '123456789012',
    })
    expect(location).toEqual({
      type: 's3',
      uri: 's3://my-bucket/image.jpg',
      bucketOwner: '123456789012',
    })
  })
})

describe('AudioBlock', () => {
  it('creates instance with bytes source', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const block = new AudioBlock({
      format: 'mp3',
      source: { bytes },
    })
    expect(block).toEqual({
      type: 'audioBlock',
      format: 'mp3',
      source: { type: 'audioSourceBytes', bytes },
    })
  })

  it('creates instance with S3 location source', () => {
    const block = new AudioBlock({
      format: 'wav',
      source: {
        location: {
          type: 's3',
          uri: 's3://my-bucket/audio.wav',
          bucketOwner: '123456789012',
        },
      },
    })
    expect(block).toEqual({
      type: 'audioBlock',
      format: 'wav',
      source: {
        type: 'audioSourceS3Location',
        location: {
          type: 's3',
          uri: 's3://my-bucket/audio.wav',
          bucketOwner: '123456789012',
        },
      },
    })
  })

  it('throws error for invalid source', () => {
    const data = {
      format: 'mp3',
      source: {},
    } as AudioBlockData
    expect(() => new AudioBlock(data)).toThrow('Invalid audio source')
  })
})

describe('ImageBlock', () => {
  it('creates instance with bytes source', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const block = new ImageBlock({
      format: 'jpeg',
      source: { bytes },
    })
    expect(block).toEqual({
      type: 'imageBlock',
      format: 'jpeg',
      source: { type: 'imageSourceBytes', bytes },
    })
  })

  it('creates instance with S3 location source', () => {
    const block = new ImageBlock({
      format: 'png',
      source: {
        location: {
          type: 's3',
          uri: 's3://my-bucket/image.png',
          bucketOwner: '123456789012',
        },
      },
    })
    expect(block).toEqual({
      type: 'imageBlock',
      format: 'png',
      source: {
        type: 'imageSourceS3Location',
        location: expect.any(S3Location),
      },
    })
    // Assert S3Location was converted to class
    const s3Source = block.source as { type: 'imageSourceS3Location'; location: S3Location }
    expect(s3Source.location).toBeInstanceOf(S3Location)
    expect(s3Source.location.uri).toBe('s3://my-bucket/image.png')
    expect(s3Source.location.bucketOwner).toBe('123456789012')
  })

  it('creates instance with URL source', () => {
    const block = new ImageBlock({
      format: 'webp',
      source: { url: 'https://example.com/image.webp' },
    })
    expect(block).toEqual({
      type: 'imageBlock',
      format: 'webp',
      source: { type: 'imageSourceUrl', url: 'https://example.com/image.webp' },
    })
  })

  it('throws error for invalid source', () => {
    const data = {
      format: 'jpeg',
      source: {},
    } as ImageBlockData
    expect(() => new ImageBlock(data)).toThrow('Invalid image source')
  })
})

describe('VideoBlock', () => {
  it('creates instance with bytes source', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const block = new VideoBlock({
      format: 'mp4',
      source: { bytes },
    })
    expect(block).toEqual({
      type: 'videoBlock',
      format: 'mp4',
      source: { type: 'videoSourceBytes', bytes },
    })
  })

  it('creates instance with S3 location source', () => {
    const block = new VideoBlock({
      format: 'webm',
      source: {
        location: {
          type: 's3',
          uri: 's3://my-bucket/video.webm',
        },
      },
    })
    expect(block).toEqual({
      type: 'videoBlock',
      format: 'webm',
      source: {
        type: 'videoSourceS3Location',
        location: expect.any(S3Location),
      },
    })
    // Assert S3Location was converted to class
    const s3Source = block.source as { type: 'videoSourceS3Location'; location: S3Location }
    expect(s3Source.location).toBeInstanceOf(S3Location)
    expect(s3Source.location.uri).toBe('s3://my-bucket/video.webm')
  })

  it('throws error for invalid source', () => {
    const data = {
      format: 'mp4',
      source: {},
    } as VideoBlockData
    expect(() => new VideoBlock(data)).toThrow('Invalid video source')
  })
})

describe('DocumentBlock', () => {
  it('creates instance with bytes source', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const block = new DocumentBlock({
      name: 'document.pdf',
      format: 'pdf',
      source: { bytes },
    })
    expect(block).toEqual({
      type: 'documentBlock',
      name: 'document.pdf',
      format: 'pdf',
      source: { type: 'documentSourceBytes', bytes },
    })
  })

  it('creates instance with text source', () => {
    const block = new DocumentBlock({
      name: 'note.txt',
      format: 'txt',
      source: { text: 'Hello world' },
    })
    expect(block).toEqual({
      type: 'documentBlock',
      format: 'txt',
      name: 'note.txt',
      source: { type: 'documentSourceText', text: 'Hello world' },
    })
  })

  it('creates instance with content source', () => {
    const block = new DocumentBlock({
      name: 'report.html',
      format: 'html',
      source: {
        content: [{ text: 'Introduction' }, { text: 'Conclusion' }],
      },
    })
    expect(block).toEqual({
      type: 'documentBlock',
      name: 'report.html',
      format: 'html',
      source: {
        type: 'documentSourceContentBlock',
        content: [expect.any(TextBlock), expect.any(TextBlock)],
      },
    })
    // Assert content blocks were converted to TextBlock instances
    const contentSource = block.source as { type: 'documentSourceContentBlock'; content: TextBlock[] }
    expect(contentSource.content).toHaveLength(2)
    expect(contentSource.content[0]).toBeInstanceOf(TextBlock)
    expect(contentSource.content[0]!.text).toBe('Introduction')
    expect(contentSource.content[1]).toBeInstanceOf(TextBlock)
    expect(contentSource.content[1]!.text).toBe('Conclusion')
  })

  it('creates instance with S3 location source', () => {
    const block = new DocumentBlock({
      name: 'report.pdf',
      format: 'pdf',
      source: {
        location: {
          type: 's3',
          uri: 's3://my-bucket/report.pdf',
          bucketOwner: '123456789012',
        },
      },
    })
    expect(block).toEqual({
      type: 'documentBlock',
      name: 'report.pdf',
      format: 'pdf',
      source: {
        type: 'documentSourceS3Location',
        location: {
          type: 's3',
          uri: 's3://my-bucket/report.pdf',
          bucketOwner: '123456789012',
        },
      },
    })
  })

  it('creates instance with bytes and filename', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const block = new DocumentBlock({
      name: 'upload.pdf',
      format: 'pdf',
      source: { bytes },
    })
    expect(block).toEqual({
      type: 'documentBlock',
      name: 'upload.pdf',
      format: 'pdf',
      source: { type: 'documentSourceBytes', bytes },
    })
  })

  it('creates instance with text and filename', () => {
    const block = new DocumentBlock({
      name: 'note.txt',
      format: 'txt',
      source: { text: 'Hello world' },
    })
    expect(block).toEqual({
      type: 'documentBlock',
      format: 'txt',
      name: 'note.txt',
      source: { type: 'documentSourceText', text: 'Hello world' },
    })
  })

  it('creates instance with citations and context', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const block = new DocumentBlock({
      name: 'research.pdf',
      format: 'pdf',
      source: { bytes },
      citations: { enabled: true },
      context: 'Research paper about AI',
    })
    expect(block).toEqual({
      type: 'documentBlock',
      name: 'research.pdf',
      format: 'pdf',
      source: {
        type: 'documentSourceBytes',
        bytes,
      },
      citations: { enabled: true },
      context: 'Research paper about AI',
    })
  })

  it('throws error for invalid source', () => {
    const data = {
      name: 'doc.pdf',
      format: 'pdf',
      source: {},
    } as DocumentBlockData
    expect(() => new DocumentBlock(data)).toThrow('Invalid document source')
  })
})

describe('encodeBase64 and decodeBase64', () => {
  it('round-trips empty array', () => {
    const original = new Uint8Array([])
    const encoded = encodeBase64(original)
    const decoded = decodeBase64(encoded)
    expect(decoded).toEqual(original)
  })

  it('round-trips single byte', () => {
    const original = new Uint8Array([42])
    const encoded = encodeBase64(original)
    const decoded = decodeBase64(encoded)
    expect(decoded).toEqual(original)
  })

  it('round-trips multi-byte array', () => {
    const original = new Uint8Array([1, 2, 3, 255, 0, 128])
    const encoded = encodeBase64(original)
    const decoded = decodeBase64(encoded)
    expect(decoded).toEqual(original)
  })

  it('round-trips large array', () => {
    const original = new Uint8Array(1000)
    for (let i = 0; i < original.length; i++) {
      original[i] = i % 256
    }
    const encoded = encodeBase64(original)
    const decoded = decodeBase64(encoded)
    expect(decoded).toEqual(original)
  })
})

describe('fromJSON with serialized (base64 string) input', () => {
  it('AudioBlock.fromJSON accepts base64 string for bytes', () => {
    const originalBytes = new Uint8Array([1, 2, 3, 4, 5])
    const base64String = encodeBase64(originalBytes)
    const block = AudioBlock.fromJSON({
      audio: { format: 'mp3', source: { bytes: base64String } },
    })
    expect((block.source as { type: 'audioSourceBytes'; bytes: Uint8Array }).bytes).toEqual(originalBytes)
  })

  it('AudioBlock.fromJSON accepts Uint8Array for bytes', () => {
    const originalBytes = new Uint8Array([1, 2, 3, 4, 5])
    const block = AudioBlock.fromJSON({
      audio: { format: 'mp3', source: { bytes: originalBytes } },
    })
    expect((block.source as { type: 'audioSourceBytes'; bytes: Uint8Array }).bytes).toEqual(originalBytes)
  })

  it('ImageBlock.fromJSON accepts base64 string for bytes', () => {
    const originalBytes = new Uint8Array([1, 2, 3, 4, 5])
    const base64String = encodeBase64(originalBytes)
    const block = ImageBlock.fromJSON({
      image: { format: 'jpeg', source: { bytes: base64String } },
    })
    expect((block.source as { type: 'imageSourceBytes'; bytes: Uint8Array }).bytes).toEqual(originalBytes)
  })

  it('ImageBlock.fromJSON accepts Uint8Array for bytes', () => {
    const originalBytes = new Uint8Array([1, 2, 3, 4, 5])
    const block = ImageBlock.fromJSON({
      image: { format: 'jpeg', source: { bytes: originalBytes } },
    })
    expect((block.source as { type: 'imageSourceBytes'; bytes: Uint8Array }).bytes).toEqual(originalBytes)
  })

  it('VideoBlock.fromJSON accepts base64 string for bytes', () => {
    const originalBytes = new Uint8Array([10, 20, 30])
    const base64String = encodeBase64(originalBytes)
    const block = VideoBlock.fromJSON({
      video: { format: 'mp4', source: { bytes: base64String } },
    })
    expect((block.source as { type: 'videoSourceBytes'; bytes: Uint8Array }).bytes).toEqual(originalBytes)
  })

  it('VideoBlock.fromJSON accepts Uint8Array for bytes', () => {
    const originalBytes = new Uint8Array([10, 20, 30])
    const block = VideoBlock.fromJSON({
      video: { format: 'mp4', source: { bytes: originalBytes } },
    })
    expect((block.source as { type: 'videoSourceBytes'; bytes: Uint8Array }).bytes).toEqual(originalBytes)
  })

  it('DocumentBlock.fromJSON accepts base64 string for bytes', () => {
    const originalBytes = new Uint8Array([100, 200])
    const base64String = encodeBase64(originalBytes)
    const block = DocumentBlock.fromJSON({
      document: { name: 'doc.pdf', format: 'pdf', source: { bytes: base64String } },
    })
    expect((block.source as { type: 'documentSourceBytes'; bytes: Uint8Array }).bytes).toEqual(originalBytes)
  })

  it('DocumentBlock.fromJSON accepts Uint8Array for bytes', () => {
    const originalBytes = new Uint8Array([100, 200])
    const block = DocumentBlock.fromJSON({
      document: { name: 'doc.pdf', format: 'pdf', source: { bytes: originalBytes } },
    })
    expect((block.source as { type: 'documentSourceBytes'; bytes: Uint8Array }).bytes).toEqual(originalBytes)
  })
})

describe('S3Location toJSON/fromJSON', () => {
  it('round-trips with uri only', () => {
    const original = new S3Location({ uri: 's3://bucket/key.jpg' })
    const json = original.toJSON()
    const restored = S3Location.fromJSON(json)
    expect(restored).toEqual(original)
  })

  it('round-trips with uri and bucketOwner', () => {
    const original = new S3Location({ uri: 's3://bucket/key.jpg', bucketOwner: '123456789012' })
    const json = original.toJSON()
    const restored = S3Location.fromJSON(json)
    expect(restored).toEqual(original)
  })

  it('includes type in JSON output', () => {
    const location = new S3Location({ uri: 's3://bucket/key.jpg' })
    const json = location.toJSON()
    expect(json).toStrictEqual({ type: 's3', uri: 's3://bucket/key.jpg' })
    expect('bucketOwner' in json).toBe(false)
  })
})

describe('AudioBlock toJSON/fromJSON', () => {
  it('round-trips with bytes source', () => {
    const original = new AudioBlock({
      format: 'mp3',
      source: { bytes: new Uint8Array([1, 2, 3]) },
    })
    const restored = AudioBlock.fromJSON(original.toJSON())
    expect(restored).toEqual(original)
  })

  it('round-trips with s3Location source', () => {
    const original = new AudioBlock({
      format: 'wav',
      source: { location: { type: 's3', uri: 's3://bucket/audio.wav', bucketOwner: '123456789012' } },
    })
    const restored = AudioBlock.fromJSON(original.toJSON())
    expect(restored).toEqual(original)
  })

  it('encodes bytes as base64 in JSON output', () => {
    const block = new AudioBlock({
      format: 'mp3',
      source: { bytes: new Uint8Array([1, 2, 3]) },
    })
    const json = block.toJSON()
    expect(typeof (json.audio.source as { bytes: unknown }).bytes).toBe('string')
  })
})

describe('ImageBlock toJSON/fromJSON', () => {
  it('round-trips with bytes source', () => {
    const original = new ImageBlock({
      format: 'jpeg',
      source: { bytes: new Uint8Array([1, 2, 3]) },
    })
    const restored = ImageBlock.fromJSON(original.toJSON())
    expect(restored).toEqual(original)
  })

  it('round-trips with url source', () => {
    const original = new ImageBlock({
      format: 'png',
      source: { url: 'https://example.com/image.png' },
    })
    const restored = ImageBlock.fromJSON(original.toJSON())
    expect(restored).toEqual(original)
  })

  it('round-trips with s3Location source', () => {
    const original = new ImageBlock({
      format: 'webp',
      source: { location: { type: 's3', uri: 's3://bucket/image.webp', bucketOwner: '123456789012' } },
    })
    const restored = ImageBlock.fromJSON(original.toJSON())
    expect(restored).toEqual(original)
  })

  it('encodes bytes as base64 in JSON output', () => {
    const block = new ImageBlock({
      format: 'jpeg',
      source: { bytes: new Uint8Array([1, 2, 3]) },
    })
    const json = block.toJSON()
    expect(typeof (json.image.source as { bytes: unknown }).bytes).toBe('string')
  })
})

describe('VideoBlock toJSON/fromJSON', () => {
  it('round-trips with bytes source', () => {
    const original = new VideoBlock({
      format: 'mp4',
      source: { bytes: new Uint8Array([10, 20, 30]) },
    })
    const restored = VideoBlock.fromJSON(original.toJSON())
    expect(restored).toEqual(original)
  })

  it('round-trips with s3Location source', () => {
    const original = new VideoBlock({
      format: 'webm',
      source: { location: { type: 's3', uri: 's3://bucket/video.webm' } },
    })
    const restored = VideoBlock.fromJSON(original.toJSON())
    expect(restored).toEqual(original)
  })

  it('encodes bytes as base64 in JSON output', () => {
    const block = new VideoBlock({
      format: 'mp4',
      source: { bytes: new Uint8Array([1, 2, 3]) },
    })
    const json = block.toJSON()
    expect(typeof (json.video.source as { bytes: unknown }).bytes).toBe('string')
  })
})

describe('DocumentBlock toJSON/fromJSON', () => {
  it('round-trips with bytes source', () => {
    const original = new DocumentBlock({
      name: 'doc.pdf',
      format: 'pdf',
      source: { bytes: new Uint8Array([100, 200]) },
    })
    const restored = DocumentBlock.fromJSON(original.toJSON())
    expect(restored).toEqual(original)
  })

  it('round-trips with text source', () => {
    const original = new DocumentBlock({
      name: 'note.txt',
      format: 'txt',
      source: { text: 'Hello world' },
    })
    const restored = DocumentBlock.fromJSON(original.toJSON())
    expect(restored).toEqual(original)
  })

  it('round-trips with content source', () => {
    const original = new DocumentBlock({
      name: 'report.html',
      format: 'html',
      source: { content: [{ text: 'Introduction' }, { text: 'Conclusion' }] },
    })
    const restored = DocumentBlock.fromJSON(original.toJSON())
    expect(restored).toEqual(original)
  })

  it('round-trips with s3Location source', () => {
    const original = new DocumentBlock({
      name: 'report.pdf',
      format: 'pdf',
      source: { location: { type: 's3', uri: 's3://bucket/report.pdf', bucketOwner: '123456789012' } },
    })
    const restored = DocumentBlock.fromJSON(original.toJSON())
    expect(restored).toEqual(original)
  })

  it('round-trips with citations and context', () => {
    const original = new DocumentBlock({
      name: 'research.pdf',
      format: 'pdf',
      source: { bytes: new Uint8Array([1, 2, 3]) },
      citations: { enabled: true },
      context: 'Research paper about AI',
    })
    const restored = DocumentBlock.fromJSON(original.toJSON())
    expect(restored).toEqual(original)
  })

  it('omits undefined citations and context from JSON', () => {
    const block = new DocumentBlock({
      name: 'doc.pdf',
      format: 'pdf',
      source: { bytes: new Uint8Array([1]) },
    })
    const json = block.toJSON()
    expect('citations' in json.document).toBe(false)
    expect('context' in json.document).toBe(false)
  })
})
