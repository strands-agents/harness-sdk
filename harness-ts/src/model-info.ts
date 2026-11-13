/**
 * The shared model info (`shared/model-info.json`), read directly for the fields the harness uses.
 * The copy is written by the `prepare` / `prebuild` scripts and git-ignored.
 */

import modelInfoData from './model-info.json' with { type: 'json' }

export interface ModelEntry {
  readonly limits?: { readonly maxOutputTokens?: number }
  readonly capabilities?: { readonly defaultEffort?: string }
}

const MODELS = modelInfoData.models as Readonly<Record<string, ModelEntry>>
const VERSION_SUFFIX = /-(?:v\d+(?::\d+)?|\d+:\d+)$/
const DATE_SUFFIX = /[-@]\d{8}$/

/** The model's entry, matched by the SDK's rule (version suffix, date, leading segments); empty when unknown. */
export function lookupModel(modelId: string): ModelEntry {
  let candidate = modelId
  for (;;) {
    const unversioned = candidate.replace(VERSION_SUFFIX, '')
    for (const key of [candidate, unversioned, unversioned.replace(DATE_SUFFIX, '')]) {
      if (Object.hasOwn(MODELS, key)) return MODELS[key]!
    }
    const dotIndex = candidate.indexOf('.')
    if (dotIndex === -1) return {}
    candidate = candidate.substring(dotIndex + 1)
  }
}
