export interface SampleCategory {
  language: string
  id: string
  label: string
}

export interface ManifestSample {
  id: string
  slug?: string
  language: string
  category: string
  categoryLabel?: string
  title: string
  description: string
  tags: string[]
  path: string
  notebook?: string
  guide?: string
  featured?: string[]
  prerequisites?: string[]
  run?: string[]
}

export interface SampleManifest {
  version: number
  repository?: string
  categories: SampleCategory[]
  samples: ManifestSample[]
}

export interface SampleSource {
  repository: string
  commit: string
  path: string
}

export interface SampleMetadata {
  title: string
  summary: string
  language: string
  category: string
  categoryLabel: string
  tags: string[]
  prerequisites: string[]
  run?: string[]
}

export interface SampleGuide {
  path: string
  kind: 'readme' | 'notebook' | 'generated'
  markdown: string
}

export interface SampleFile {
  path: string
  language: string
  content: string
}

export interface SampleDetail {
  id: string
  slug: string
  source: SampleSource
  metadata: SampleMetadata
  guide: SampleGuide
  files: SampleFile[]
  skippedFileCount: number
}

export interface SampleSnapshot {
  schemaVersion: 2
  source: {
    repository: string
    commit: string
    manifest: string
  }
  categories: SampleCategory[]
  stats: {
    sampleCount: number
    fileCount: number
    skippedFileCount: number
  }
  samples: SampleDetail[]
}
