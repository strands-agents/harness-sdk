export interface SampleCategory {
  language: string
  id: string
  label: string
}

export interface ManifestSample {
  slug?: string
  language: string
  category: string
  title: string
  description: string
  path: string
  notebook?: string
}

export interface SampleManifest {
  version: number
  repository?: string
  categories: SampleCategory[]
  samples: ManifestSample[]
}

export interface BuildSampleGuidesOptions {
  sourceDir: string
  outputDir: string
}

export interface SampleGuideBuild {
  repository: string
  commit: string
  sampleCount: number
}
